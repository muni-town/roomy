import type { QueryClient } from "@tanstack/svelte-query";
import { sync } from "@roomy-space/sdk";
import { createTanstackCacheAdapter } from "@roomy-space/sdk/browser";
import { resolveAppserverWsOrigin } from "./did-resolve";

const { SyncConnection: SdkSyncConnection, SyncRouter, TopicManager } = sync;

// ── Sync connection state ─────────────────────────────────────────────────

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface SyncConnection {
	connect: () => Promise<void>;
	disconnect: () => void;
	subscribe: (topic: "space" | "room", id: string) => void;
	unsubscribe: (topic: "space" | "room", id: string) => void;
	readonly state: ConnectionState;
	readonly lastSeq: number;
}

// ── Create a sync connection bound to a queryClient ───────────────────────

export function createSyncConnection(deps: {
	queryClient: QueryClient;
	fetchTicket: () => Promise<string>;
	appserverDid: string;
	onLog?: (msg: string) => void;
	onMessageDiff?: (roomId: string, seq: number) => void;
}): SyncConnection {
	const { queryClient, fetchTicket, appserverDid, onLog, onMessageDiff } = deps;

	let connection: InstanceType<typeof SdkSyncConnection> | null = null;
	let router: InstanceType<typeof SyncRouter> | null = null;
	let topics: InstanceType<typeof TopicManager> | null = null;
	const topicHolds = new Map<string, () => void>();

	let state = $state<ConnectionState>("disconnected");
	let lastSeq = $state(0);

	function log(msg: string) {
		onLog?.(msg);
	}

	async function connect() {
		if (connection) return; // already wired

		state = "connecting";
		let wsOrigin: string;
		try {
			log(`Resolving WS origin from ${appserverDid}…`);
			wsOrigin = await resolveAppserverWsOrigin(appserverDid);
			log(`Resolved → ${wsOrigin}`);
		} catch (err: any) {
			log(`DID resolution failed: ${err?.message ?? err}`);
			state = "error";
			return;
		}

		// Build SDK connection. SyncConnection handles ticket fetch + reconnect.
		connection = new SdkSyncConnection({
			wsUrl: `${wsOrigin}/xrpc/space.roomy.sync.subscribe`,
			fetchTicket,
			logger: log,
		});

		// Mirror SDK status into Svelte $state.
		connection.onStatusChange((s) => {
			switch (s.state) {
				case "connecting":
				case "reconnecting":
					state = "connecting";
					break;
				case "open":
					state = "connected";
					break;
				case "closing":
				case "idle":
					state = "disconnected";
					break;
				case "closed":
					state = "disconnected";
					break;
			}
		});

		// Route #invalidate / #messageDiff into TanStack via the SDK adapter.
		// Also track lastSeq from messageDiff frames + notify caller.
		connection.onFrame((frame) => {
			const t = frame.header["t"];
			if (t === "#messageDiff") {
				const seq = (frame.body as { seq?: number }).seq;
				const roomId = (frame.body as { roomId?: string }).roomId;
				if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
				if (typeof roomId === "string" && typeof seq === "number") {
					onMessageDiff?.(roomId, seq);
				}
			}
		});

		router = new SyncRouter(connection, createTanstackCacheAdapter(queryClient), {
			onValidationError: ({ frameType, summary }) =>
				log(`[validation error ${frameType}] ${summary}`),
			onUnknownFrame: (f) => log(`[unknown frame] ${JSON.stringify(f.header)}`),
		});
		router.start();
		topics = new TopicManager(connection);

		try {
			await connection.connect();
		} catch (err: any) {
			log(`Connect failed: ${err?.message ?? err}`);
			state = "error";
		}
	}

	function disconnect() {
		router?.stop();
		connection?.close();
		for (const dispose of topicHolds.values()) dispose();
		topicHolds.clear();
		connection = null;
		router = null;
		topics = null;
		state = "disconnected";
	}

	function subscribe(topic: "space" | "room", id: string) {
		if (!topics) {
			log("Cannot subscribe — not connected.");
			return;
		}
		const key = `${topic}:${id}`;
		if (topicHolds.has(key)) return;
		topicHolds.set(key, topics.acquire({ kind: topic, id }));
		log(`→ sub ${topic}:${id.slice(0, 8)}…`);
	}

	function unsubscribe(topic: "space" | "room", id: string) {
		const key = `${topic}:${id}`;
		const dispose = topicHolds.get(key);
		if (!dispose) return;
		dispose();
		topicHolds.delete(key);
		log(`→ unsub ${topic}:${id.slice(0, 8)}…`);
	}

	return {
		get state() { return state; },
		get lastSeq() { return lastSeq; },
		connect,
		disconnect,
		subscribe,
		unsubscribe,
	};
}
