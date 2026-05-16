import type { QueryClient } from "@tanstack/svelte-query";
import { decodeCborFrame } from "$lib/xrpc";
import { resolveAppserverWsOrigin } from "./did-resolve";
import type {
	Message,
	MessageDiffFrame,
	InvalidationFrame,
	MessageDiffOp,
} from "./types";

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
	onMessageDiff?: (diff: MessageDiffFrame) => void;
}): SyncConnection {
	const { queryClient, fetchTicket, appserverDid, onLog, onMessageDiff } = deps;

	let ws: WebSocket | null = null;
	let state = $state<ConnectionState>("disconnected");
	let lastSeq = $state(0);
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let intentionalClose = false;

	function log(msg: string) {
		onLog?.(msg);
	}

	async function connect() {
		if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

		intentionalClose = false;
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

		log("Requesting ticket…");
		let ticket: string;
		try {
			ticket = await fetchTicket();
			log(`Got ticket: ${ticket.slice(0, 12)}…`);
		} catch (err: any) {
			log(`Ticket failed: ${err?.message ?? err}`);
			state = "error";
			return;
		}

		const url = `${wsOrigin}/xrpc/space.roomy.sync.subscribe?ticket=${encodeURIComponent(ticket)}`;
		log(`Connecting to ${url.split("?")[0]}…`);

		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		ws = socket;

		socket.onopen = () => {
			state = "connected";
			log("Connected.");
		};

		socket.onmessage = (event) => {
			if (typeof event.data === "string") {
				log(`[text] ${event.data}`);
				return;
			}

			try {
				const { header, body } = decodeCborFrame(event.data as ArrayBuffer);
				const t = header["t"] as string;

				if (t === "#messageDiff") {
					handleMessageDiff(body as unknown as MessageDiffFrame);
				} else if (t === "#invalidate") {
					handleInvalidation(body as unknown as InvalidationFrame);
				} else if (t === "#error") {
					log(`[ERROR] ${(body as any).error}: ${(body as any).message}`);
				} else {
					log(`[unknown t=${t}] ${JSON.stringify(body)}`);
				}
			} catch (err) {
				log(`[decode error] ${err}`);
			}
		};

		socket.onclose = (event) => {
			state = "disconnected";
			ws = null;
			log(`Closed: code=${event.code} reason=${event.reason}`);

			// Auto-reconnect with backoff unless intentional
			if (!intentionalClose) {
				const delay = 2000 + Math.random() * 1000;
				log(`Reconnecting in ${Math.round(delay)}ms…`);
				reconnectTimer = setTimeout(() => connect(), delay);
			}
		};

		socket.onerror = () => {
			log("WebSocket error.");
			state = "error";
		};
	}

	function disconnect() {
		intentionalClose = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		ws?.close();
		ws = null;
		state = "disconnected";
	}

	function subscribe(topic: "space" | "room", id: string) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			log("Cannot subscribe — not connected.");
			return;
		}
		ws.send(JSON.stringify({ type: "sub", topic, id }));
		log(`→ sub ${topic}:${id.slice(0, 8)}…`);
	}

	function unsubscribe(topic: "space" | "room", id: string) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: "unsub", topic, id }));
		log(`→ unsub ${topic}:${id.slice(0, 8)}…`);
	}

	// ── Frame handlers ───────────────────────────────────────────────────

	function handleMessageDiff(diff: MessageDiffFrame) {
		if (diff.seq > lastSeq) lastSeq = diff.seq;

		const ops = diff.ops;
		const summary = ops.map((o) => `${o.op} ${o.key.slice(0, 8)}…`).join(", ");
		log(`[#messageDiff] room=${diff.roomId.slice(0, 8)}… seq=${diff.seq} ops: ${summary}`);

		// Notify listener (e.g. to trigger updateSeen)
		onMessageDiff?.(diff);

		// Apply diff directly to TanStack Query cache — no HTTP round-trip.
		// The query stores Message[] (unwrapped from the response),
		// so setQueryData receives Message[] and must return Message[].
		queryClient.setQueryData(
			["space.roomy.room.getMessages", { roomId: diff.roomId }],
			(old: Message[] | undefined) => {
				if (!old) return old;
				return applyMessageDiff(old, ops);
			},
		);
	}

	function handleInvalidation(frame: InvalidationFrame) {
		log(`[#invalidate] ${frame.nsid} ${JSON.stringify(frame.params)}`);

		// Trigger HTTP re-fetch for the specified query
		queryClient.invalidateQueries({
			queryKey: [frame.nsid, frame.params],
		});
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

// ── Diff application ──────────────────────────────────────────────────────

function applyMessageDiff(messages: Message[], ops: MessageDiffOp[]): Message[] {
	const map = new Map(messages.map((m) => [m.id, m]));
	for (const op of ops) {
		if (op.op === "add" && op.message) {
			map.set(op.key, op.message);
		} else if (op.op === "update" && op.message) {
			const existing = map.get(op.key);
			map.set(op.key, existing ? { ...existing, ...op.message } : op.message);
		} else if (op.op === "remove") {
			map.delete(op.key);
		}
	}
	return [...map.values()].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);
}
