/**
 * Tests for LiveRoomyGateway.
 *
 * The onFrame handler in subscribe() polls the space.roomy.sync.getEvents
 * XRPC endpoint for new events and invokes the RoomyEventCallback for each
 * decoded event.
 */

import { encode } from "@atcute/cbor";
import { beforeEach, describe, expect, test, vi, afterEach } from "bun:test";
import { type Event, newUlid, transport } from "@roomy-space/sdk";
import { BridgeRepository } from "../db/repository.ts";
import { LiveRoomyGateway } from "./live-gateway.ts";
import type { RoomyEventCallback } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";
// ─── Minimal CBOR encoder ─────────────────────────────────────────────────
// We only need to encode simple objects for test frames. This avoids pulling
// @atcute/cbor as a direct dependency of the discord-bridge package.

function cborEncode(value: unknown): Uint8Array {
	const bufs: Uint8Array[] = [];
	function enc(v: unknown): void {
		if (typeof v === "string") {
			const bytes = new TextEncoder().encode(v);
			const major = 3; // major type 3 = text string
			encHead(major, bytes.length);
			bufs.push(bytes);
		} else if (typeof v === "number") {
			if (v >= 0 && Number.isInteger(v) && v <= 0xffffffff) {
				encHead(0, v);
			} else {
				throw new Error("unsupported number");
			}
		} else if (v === true) {
			bufs.push(new Uint8Array([0xf5]));
		} else if (v === false) {
			bufs.push(new Uint8Array([0xf4]));
		} else if (v === null) {
			bufs.push(new Uint8Array([0xf6]));
		} else if (Array.isArray(v)) {
			encHead(4, v.length);
			for (const item of v) enc(item);
		} else if (v && typeof v === "object") {
			const keys = Object.keys(v);
			encHead(5, keys.length);
			for (const key of keys) {
				enc(key);
				enc((v as Record<string, unknown>)[key]);
			}
		} else {
			throw new Error(`unsupported CBOR value: ${typeof v}`);
		}
	}
	function encHead(major: number, count: number): void {
		if (count < 24) {
			bufs.push(new Uint8Array([(major << 5) | count]));
		} else if (count < 0x100) {
			bufs.push(new Uint8Array([(major << 5) | 24, count]));
		} else if (count < 0x10000) {
			bufs.push(new Uint8Array([(major << 5) | 25, count >> 8, count & 0xff]));
		} else {
			bufs.push(new Uint8Array([(major << 5) | 26, (count >> 24) & 0xff, (count >> 16) & 0xff, (count >> 8) & 0xff, count & 0xff]));
		}
	}
	enc(value);
	const total = bufs.reduce((s, b) => s + b.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const b of bufs) {
		result.set(b, offset);
		offset += b.length;
	}
	return result;
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
	// Provide the readyState constants the SUT reads from the constructor.
	(ctor as unknown as { OPEN: number }).OPEN = 1;
	(ctor as unknown as { CONNECTING: number }).CONNECTING = 0;
	(ctor as unknown as { CLOSING: number }).CLOSING = 2;
	(ctor as unknown as { CLOSED: number }).CLOSED = 3;
	return ctor;
}

function buildFrame(t: string, body: Record<string, unknown>): ArrayBuffer {
	const header = cborEncode({ t });
	const bodyBytes = cborEncode(body);
	const out = new Uint8Array(header.byteLength + bodyBytes.byteLength);
	out.set(header, 0);
	out.set(bodyBytes, header.byteLength);
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
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
 * CBOR-encode an event object so it can be used as a raw.payload in the
 * getEvents response. The gateway decodes this with decode().
 */
function encodeEventPayload(event: Event): string {
	const bytes = encode(event);
	return btoa(String.fromCharCode(...bytes));
}

// ─── Setup ─────────────────────────────────────────────────────────────────

function setup() {
	const repo = BridgeRepository.open(":memory:");

	const mockXrpc = {
		procedure: vi.fn().mockResolvedValue({ ticket: "test-ticket" }),
		query: vi.fn(),
	} as unknown as transport.DirectXrpcClient;

	const mockSpaceManager = {
		disconnectAll: vi.fn(),
	} as unknown as SpaceManager;

	const gateway = new LiveRoomyGateway(mockSpaceManager, repo, mockXrpc, WS_URL);

	return { repo, gateway, mockXrpc, mockSpaceManager };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("LiveRoomyGateway", () => {
	let repo: BridgeRepository;
	let gateway: LiveRoomyGateway;
	let mockXrpc: transport.DirectXrpcClient;
	let origWebSocket: typeof WebSocket | undefined;

	beforeEach(() => {
		lastSocket = null;
		sockets.length = 0;
		// Mock the global WebSocket since LiveRoomyGateway doesn't pass
		// webSocketImpl to SyncConnection — it reads from globalThis.
		origWebSocket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		(globalThis as { WebSocket: typeof WebSocket }).WebSocket = makeMockWS();
		const s = setup();
		repo = s.repo;
		gateway = s.gateway;
		mockXrpc = s.mockXrpc;
	});

	afterEach(() => {
		repo.close();
		// Restore the original WebSocket
		if (origWebSocket) {
			(globalThis as { WebSocket: typeof WebSocket }).WebSocket = origWebSocket;
		} else {
			delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		}
	});

	/**
	 * Inject a sync frame into the SyncConnection and assert the callback is
	 * invoked with the decoded event and metadata.
	 */
	test("callback is invoked on frame", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event = makeEvent();
		const payloadB64 = encodeEventPayload(event);

		// Mock the XRPC query to return one event when getEvents is called.
		mockXrpc.query = vi.fn().mockResolvedValue({
			events: [{ idx: 1, user: "did:web:test-user", payload: { $bytes: payloadB64 } }],
			cursor: 1,
		});

		// Subscribe — creates a SyncConnection with our mock WebSocket
		const subPromise = gateway.subscribe(SPACE_DID, callback);

		// Let the ticket fetch resolve
		await Promise.resolve();
		await Promise.resolve();

		expect(lastSocket).toBeTruthy();

		// Open the socket so the connect() promise resolves
		lastSocket!._open();
		await subPromise;

		// Inject a frame — this triggers the onFrame handler which polls getEvents
		lastSocket!._emitMessage(buildFrame("#invalidate", { nsid: "x" }));

		// Wait for the async onFrame handler to complete
		await Promise.resolve();
		await Promise.resolve();

		// The callback should be called once with the decoded event and meta.
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(event, {
			spaceDid: SPACE_DID,
			isBackfill: false,
			userDid: "did:web:test-user",
		});
	});

	test("callback invoked once per decoded event", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;
		const event1 = makeEvent();
		const event2 = makeEvent();
		const payload1 = encodeEventPayload(event1);
		const payload2 = encodeEventPayload(event2);

		// Mock query to return one event per call, advancing cursor.
		let callCount = 0;
		mockXrpc.query = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({
					events: [{ idx: 1, user: "did:web:user-a", payload: { $bytes: payload1 } }],
					cursor: 1,
				});
			}
			return Promise.resolve({
				events: [{ idx: 2, user: "did:web:user-b", payload: { $bytes: payload2 } }],
				cursor: 2,
			});
		});

		const subPromise = gateway.subscribe(SPACE_DID, callback);
		await Promise.resolve();
		await Promise.resolve();
		lastSocket!._open();
		await subPromise;

		// Inject two frames
		lastSocket!._emitMessage(buildFrame("#invalidate", { nsid: "a" }));
		lastSocket!._emitMessage(buildFrame("#invalidate", { nsid: "b" }));

		// Wait for both async onFrame handlers to complete
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

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

	/**
	 * Inject a frame that carries no event (e.g. a heartbeat) and assert the
	 * callback is NOT invoked.
	 */
	test("frames with no event don't invoke callback", async () => {
		const callback = vi.fn() as unknown as RoomyEventCallback;

		// Mock query to return empty events array.
		mockXrpc.query = vi.fn().mockResolvedValue({
			events: [],
			cursor: 0,
		});

		const subPromise = gateway.subscribe(SPACE_DID, callback);
		await Promise.resolve();
		await Promise.resolve();
		lastSocket!._open();
		await subPromise;

		// Inject a heartbeat frame (no event payload)
		lastSocket!._emitMessage(buildFrame("#heartbeat", {}));

		// Wait for the async onFrame handler
		await Promise.resolve();
		await Promise.resolve();

		expect(callback).not.toHaveBeenCalled();
	});
});
