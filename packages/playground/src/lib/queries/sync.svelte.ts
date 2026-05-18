/**
 * Playground sync context — creates the SDK sync primitives and returns
 * them for use with SDK runes from `@roomy-space/sdk/svelte`.
 *
 * App-specific concerns (DID resolution, queryClient wiring, logging)
 * live here. Reactive state (connection status, topic subscriptions)
 * is handled by the SDK runes, not this module.
 */

import type { QueryClient } from "@tanstack/svelte-query";
import { sync } from "@roomy-space/sdk";
import type {
  SyncConnectionLike,
  TopicManagerLike,
} from "@roomy-space/sdk/svelte";
import { createTanstackCacheAdapter } from "@roomy-space/sdk/browser";
import { resolveAppserverWsOrigin } from "./did-resolve";

const { SyncConnection, SyncRouter, TopicManager } = sync;

export interface SyncContext {
	connect: () => Promise<void>;
	disconnect: () => void;
	readonly connection: SyncConnectionLike;
	readonly topicManager: TopicManagerLike;
}

export function createSyncContext(deps: {
	queryClient: QueryClient;
	fetchTicket: () => Promise<string>;
	appserverDid: string;
	onLog?: (msg: string) => void;
	onMessageDiff?: (roomId: string, seq: number) => void;
}): SyncContext {
	const { queryClient, fetchTicket, appserverDid, onLog, onMessageDiff } = deps;

	let connection: InstanceType<typeof SyncConnection> | null = null;
	let router: InstanceType<typeof SyncRouter> | null = null;
	let topics: InstanceType<typeof TopicManager> | null = null;

	function log(msg: string) {
		onLog?.(msg);
	}

	async function connect() {
		if (connection) return; // already wired

		let wsOrigin: string;
		try {
			log(`Resolving WS origin from ${appserverDid}…`);
			wsOrigin = await resolveAppserverWsOrigin(appserverDid);
			log(`Resolved → ${wsOrigin}`);
		} catch (err: any) {
			log(`DID resolution failed: ${err?.message ?? err}`);
			throw err;
		}

		// Build SDK connection. SyncConnection handles ticket fetch + reconnect.
		connection = new SyncConnection({
			wsUrl: `${wsOrigin}/xrpc/space.roomy.sync.subscribe`,
			fetchTicket,
			logger: log,
		});

		// Track messageDiff frames for caller notification.
		connection.onFrame((frame) => {
			const t = frame.header["t"];
			if (t === "#messageDiff") {
				const seq = (frame.body as { seq?: number }).seq;
				const roomId = (frame.body as { roomId?: string }).roomId;
				if (typeof roomId === "string" && typeof seq === "number") {
					onMessageDiff?.(roomId, seq);
				}
			}
		});

		// Route #invalidate / #messageDiff into TanStack via the SDK adapter.
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
			throw err;
		}
	}

	function disconnect() {
		router?.stop();
		connection?.close();
		connection = null;
		router = null;
		topics = null;
	}

	return {
		get connection() { return connection!; },
		get topicManager() { return topics!; },
		connect,
		disconnect,
	};
}
