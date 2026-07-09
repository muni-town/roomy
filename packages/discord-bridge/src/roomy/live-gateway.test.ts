/**
 * Tests for LiveRoomyGateway.
 *
 * The gateway subscribes to a `stream` topic via SyncConnection. The
 * appserver sends `#streamEvents` CBOR frames containing batches of
 * decoded events. The gateway invokes the RoomyEventCallback for each
 * event and persists the cursor.
 */

import { encode } from "@atcute/cbor";
import { beforeEach, describe, expect, test, vi, afterEach, type Mock } from "bun:test";
import { type Event, newUlid, transport } from "@roomy-space/sdk";
import { BridgeRepository } from "../db/repository.ts";
import { LiveRoomyGateway } from "./live-gateway.ts";
import type { RoomyEventCallback } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";

// ─── CBOR frame builder ─────────────────────────────────────────────────

function buildFrame(t: string, body: Record<string, unknown>): ArrayBuffer {
	const headerBytes = encode({ t });
	const bodyBytes = encode(body);
	const out = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
	out.set(headerBytes, 0);
	out.set(bodyBytes, headerBytes.byteLength);
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ─── Mock WebSocket ───────────────────────────────────────────────────────

type ReadyState = 0 | 1 | 2 | 3;

interface MockSocket {
	url: string;
	readyState: ReadyState;
	binaryType: string;
	sent: string[];
	onopen: ((ev: Event) => void) | null;
	onmessage: ((ev: MessageEvent) => void) | null;
	onclose: ((ev: CloseEvent) => void) | null;
	onerror: ((ev: Event) => void) | null;
	send: (data: string) => void;
	close: () => void;
	/** Test helpers — not part of the WebSocket spec. */
	_open: () => void;
	_emitMessage: (data: ArrayBuffer | string) => void;
	_emitClose: (code?: number, reason?: string) => void;
	_emitError: () => void;
}

let lastSocket: MockSocket | null = null;
const sockets: MockSocket[] = [];

function makeMockWS(): typeof WebSocket {
	const ctor = function (this: MockSocket, url: string) {
		const self = this;
		self.url = url;
		self.readyState = 0; // CONNECTING
		self.binaryType = "blob";
		self.sent = [];
		self.onopen = null;
		self.onmessage = null;
		self.onclose = null;
		self.onerror = null;
		self.send = (data: string) => {
			if (self.readyState !== 1) throw new Error("send on non-open socket");
			self.sent.push(data);
		};
		self.close = () => {
			if (self.readyState === 3) return;
			self.readyState = 2;
			queueMicrotask(() => self._emitClose(1000, "normal"));
		};
		self._open = () => {
			self.readyState = 1;
			self.onopen?.(new Event("open"));
		};
		self._emitMessage = (data: ArrayBuffer | string) => {
			self.onmessage?.({ data } as MessageEvent);
		};
		self._emitClose = (code = 1006, reason = "") => {
			self.readyState = 3;
			self.onclose?.({ code, reason } as CloseEvent);
		};
		self._emitError = () => {
			self.onerror?.(new Event("error"));
		};
		lastSocket = self;
		sockets.push(self);
	} as unknown as typeof WebSocket;
	(ctor as unknown as { OPEN: number }).OPEN = 1;
	(ctor as unknown as { CONNECTING: number }).CONNECTING = 0;
	(ctor as unknown as { CLOSING: number }).CLOSING = 2;
	(ctor as unknown as { CLOSED: number }).CLOSED = 3;
	return ctor;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SPACE_DID = "did:web:test-space";
const WS_URL = "wss://test/ws";

function makeEvent(): Event {
	return {
		$type: "space.roomy.space.updateInfo",
		id: newUlid(),
		name: "Test Event",
		description: "A test event",
	} as Event;
}

/**
 * Build a #streamEvents frame body matching the appserver's format.
 * Each event's `payload` is the decoded event object (not CBOR bytes).
 */
function buildStreamEventsBody(
	streamDid: string,
	events: Array<{ idx: number; user: string; event: Event }>,
	cursor: number,
	hasMore = false,
): Record<string, unknown> {
	return {
		streamDid,
		cursor,
		hasMore,
		events: events.map((e) => ({
			idx: e.idx,
			user: e.user,
			payload: e.event,
		})),
	};
}

// ─── Setup ─────────────────────────────────────────────────────────────────

function setup() {
	const repo = BridgeRepository.open(":memory:");

	const procedure = vi.fn().mockResolvedValue({ ticket: "test-ticket" });
	const mockXrpc = {
		procedure,
		query: vi.fn(),
	} as unknown as transport.DirectXrpcClient;

	const mockSpaceManager = {
		disconnectAll: vi.fn(),
	} as unknown as SpaceManager;

	const gateway = new LiveRoomyGateway(mockSpaceManager, repo, mockXrpc, WS_URL);

	return { repo, gateway, mockXrpc, mockSpaceManager, procedure };
}

/** Drain the microtask queue enough for async frame processing to complete. */
async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("LiveRoomyGateway", () => {
	let repo: BridgeRepository;
	let gateway: LiveRoomyGateway;
	let mockXrpc: transport.DirectXrpcClient;
	let procedure: Mock;
	let origWebSocket: typeof WebSocket | undefined;

	beforeEach(() => {
		lastSocket = null;
		sockets.length = 0;
		origWebSocket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		(globalThis as { WebSocket: typeof WebSocket }).WebSocket = makeMockWS();
		const s = setup();
		repo = s.repo;
		gateway = s.gateway;
		mockXrpc = s.mockXrpc;
		procedure = s.procedure;
	});

	afterEach(() => {
		repo.close();
		if (origWebSocket) {
			(globalThis as { WebSocket: typeof WebSocket }).WebSocket = origWebSocket;
		} else {
			delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		}
	});

	/** Subscribe and open the mock socket so the connect() promise resolves. */
	async function subscribeAndConnect(
		spaceDid: string,
		callback: RoomyEventCallback,
	): Promise<void> {
		const subPromise = gateway.subscribe(spaceDid, callback);
		await Promise.resolve();
		await Promise.resolve();
		expect(lastSocket).toBeTruthy();
		lastSocket!._open();
		await subPromise;
	}

	/**
	 * Inject a #streamEvents frame and wait for the async onFrame handler
	 * to complete.
	 */
	async function emitStreamEvents(
		spaceDid: string,
		events: Array<{ idx: number; user: string; event: Event }>,
		cursor: number,
		hasMore = false,
	): Promise<void> {
		lastSocket!._emitMessage(
			buildFrame(
				"#streamEvents",
				buildStreamEventsBody(spaceDid, events, cursor, hasMore),
			),
		);
		await flush();
	}

	test("callback is invoked for each event in a #streamEvents frame", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 0, user: "did:web:test-user", event }],
			0,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(event, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});
	});

	test("cursor is persisted after each frame", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 5, user: "did:web:test-user", event }],
			5,
		);

		expect(repo.getSpaceCursor(SPACE_DID)).toBe(5);
	});

	test("multiple events in one frame are all delivered", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event1 = makeEvent();
		const event2 = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(
			SPACE_DID,
			[
				{ idx: 0, user: "did:web:user-a", event: event1 },
				{ idx: 1, user: "did:web:user-b", event: event2 },
			],
			1,
		);

		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback).toHaveBeenNthCalledWith(1, event1, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:user-a",
		});
		expect(callback).toHaveBeenNthCalledWith(2, event2, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:user-b",
		});
	});

	test("isBackfill is true when hasMore is true", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 0, user: "did:web:test-user", event }],
			0,
			true, // hasMore — still backfilling
		);

		expect(callback).toHaveBeenCalledWith(event, {
			spaceDid: SPACE_DID,
			isBackfill: true,
			userDid: "did:web:test-user",
		});
	});

	test("isBackfill transitions from true to false when hasMore flips to false (L1)", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event1 = makeEvent();
		const event2 = makeEvent();
		const event3 = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);

		// First frame: hasMore=true → still backfilling → isBackfill=true.
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 0, user: "did:web:test-user", event: event1 }],
			0,
			true,
		);
		expect(callback).toHaveBeenNthCalledWith(1, event1, {
			spaceDid: SPACE_DID,
			isBackfill: true,
			userDid: "did:web:test-user",
		});

		// Second frame: hasMore=false → transition point → isBackfill=false
		// (backfilling was still true at the start of this frame, but
		// `true && false === false`).
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 1, user: "did:web:test-user", event: event2 }],
			1,
			false,
		);
		expect(callback).toHaveBeenNthCalledWith(2, event2, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});

		// Third frame: hasMore=false → now live → isBackfill=false.
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 2, user: "did:web:test-user", event: event3 }],
			2,
			false,
		);
		expect(callback).toHaveBeenNthCalledWith(3, event3, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});
	});

	test("frames with no events don't invoke callback", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(SPACE_DID, [], 0);

		expect(callback).not.toHaveBeenCalled();
	});

	test("non-#streamEvents frames are ignored", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		await subscribeAndConnect(SPACE_DID, callback);
		lastSocket!._emitMessage(buildFrame("#invalidate", { nsid: "x" }));
		await flush();

		expect(callback).not.toHaveBeenCalled();
	});

	test("a failing callback doesn't block subsequent events", async () => {
		const callback = vi.fn().mockRejectedValueOnce(new Error("boom")) as unknown as RoomyEventCallback;
		const event1 = makeEvent();
		const event2 = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);
		await emitStreamEvents(
			SPACE_DID,
			[
				{ idx: 0, user: "did:web:user-a", event: event1 },
				{ idx: 1, user: "did:web:user-b", event: event2 },
			],
			1,
		);

		expect(callback).toHaveBeenCalledTimes(2);
	});

	test("malformed event payload is skipped without aborting the batch", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const goodEvent = makeEvent();

	await subscribeAndConnect(SPACE_DID, callback);
	// Inject a frame with one malformed event (no $type) and one good one.
	const body = buildStreamEventsBody(
		SPACE_DID,
		[
			{ idx: 0, user: "u", event: { notType: true } as unknown as Event },
			{ idx: 1, user: "u", event: goodEvent },
		],
		1,
	);
	lastSocket!._emitMessage(buildFrame("#streamEvents", body));
	await flush();

	// Only the good event (idx 1) should be delivered.
	expect(callback).toHaveBeenCalledTimes(1);
	expect(callback).toHaveBeenCalledWith(goodEvent, expect.objectContaining({ userDid: "u" }));
	});

	test("unsubscribe closes the connection", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		await subscribeAndConnect(SPACE_DID, callback);
		await gateway.unsubscribe(SPACE_DID);

		// The mock socket's close() schedules a close event via microtask.
		await flush();
		expect(lastSocket!.readyState).toBe(3); // CLOSED
	});

	test("resuming from a persisted cursor subscribes with that cursor", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		// Seed a cursor.
		repo.setSpaceCursor(SPACE_DID, 10);

		await subscribeAndConnect(SPACE_DID, callback);

		// The SDK replays the topic registered before connect (cursor 10),
		// then the onOpen handler (M3) unsubscribes the stale topic and
		// re-subscribes with the fresh cursor from the repo (also 10 here,
		// since no frames have arrived yet). Both sub messages carry 10.
		const subMessages = lastSocket!.sent.filter((s) => s.includes('"sub"'));
		expect(subMessages.length).toBe(2);
		expect(subMessages[0]).toContain('"cursor":10');
		expect(subMessages[1]).toContain('"cursor":10');
		// The onOpen handler sends an unsub before re-subscribing.
		expect(lastSocket!.sent.some((s) => s.includes('"type":"unsub"'))).toBe(true);
	});

	test("no persisted cursor subscribes with cursor -1 (full backfill)", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		await subscribeAndConnect(SPACE_DID, callback);

		// Replay sub and the onOpen re-subscribe both use cursor -1 (no
		// persisted cursor). The last sub message is the fresh-cursor one.
		const subMessages = lastSocket!.sent.filter((s) => s.includes('"sub"'));
		expect(subMessages.length).toBe(2);
		expect(subMessages[subMessages.length - 1]).toContain('"cursor":-1');
	});

	test("connect failure cleans up the subscription so re-subscribe works (M2)", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		// Make the next ticket fetch fail so connect() rejects.
		procedure.mockRejectedValueOnce(new Error("ticket fail"));
		await expect(gateway.subscribe(SPACE_DID, callback)).rejects.toThrow(
			"ticket fail",
		);

		// No socket was constructed (fetchTicket rejects before the WS ctor),
		// and the failed subscription must have been removed so a retry works.
		expect(lastSocket).toBeNull();

		// Re-subscribe: the default resolving procedure is restored, so this
		// connects normally.
		await subscribeAndConnect(SPACE_DID, callback);
		const event = makeEvent();
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 0, user: "did:web:test-user", event }],
			0,
		);
		expect(callback).toHaveBeenCalledWith(event, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});
	});

	test("backfillState resets to true on reconnect (Med3)", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event1 = makeEvent();
		const event2 = makeEvent();
		const event3 = makeEvent();

		await subscribeAndConnect(SPACE_DID, callback);

		// Backfill phase: hasMore=true → isBackfill=true.
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 0, user: "did:web:test-user", event: event1 }],
			0,
			true,
		);
		expect(callback).toHaveBeenNthCalledWith(1, event1, {
			spaceDid: SPACE_DID,
			isBackfill: true,
			userDid: "did:web:test-user",
		});

		// Backfill completes: hasMore=false → isBackfill=false, backfillState now false.
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 1, user: "did:web:test-user", event: event2 }],
			1,
			false,
		);
		expect(callback).toHaveBeenNthCalledWith(2, event2, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});

		// Simulate a reconnect by re-firing the socket's onopen, which invokes
		// the onOpen handlers the gateway registered. Med3 resets backfillState
		// to true here, so the reconnect's backfill frames are labeled correctly.
		lastSocket!._open();
		await flush();

		// Reconnect backfill frame: hasMore=true. Without the Med3 reset this
		// would be isBackfill=false (backfillState stuck at false from before).
		await emitStreamEvents(
			SPACE_DID,
			[{ idx: 2, user: "did:web:test-user", event: event3 }],
			2,
			true,
		);
		expect(callback).toHaveBeenNthCalledWith(3, event3, {
			spaceDid: SPACE_DID,
			isBackfill: true,
			userDid: "did:web:test-user",
		});
	});

});