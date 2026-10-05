import { afterEach, describe, expect, test } from "bun:test";
import type { Event } from "@roomy-space/sdk";
import type { RoomyGateway } from "./gateway.ts";
import {
	sendSystemMessage,
	systemMessagesConfigured,
} from "./system-messages.ts";

const SPACE = "did:plc:system-test";
const CHANNEL = "01KZBRQMEP2FTE079YRVDFKGTA";

function makeGateway(): {
	gateway: RoomyGateway;
	sent: Array<{ spaceDid: string; event: Event }>;
} {
	const sent: Array<{ spaceDid: string; event: Event }> = [];
	const gateway: RoomyGateway = {
		sendEvent: async (spaceDid, event) => {
			sent.push({ spaceDid, event });
		},
		sendEvents: async () => {},
		getSidebar: async () => ({ categories: [] }),
		getRoomMessages: async () => ({ messages: [] }),
		subscribe: async () => {},
		unsubscribe: async () => {},
		disconnectAll: async () => {},
	};
	return { gateway, sent };
}

afterEach(() => {
	delete process.env.SYSTEM_SPACE;
	delete process.env.SYSTEM_CHANNEL;
});

describe("systemMessagesConfigured", () => {
	test("false when both env vars are unset", () => {
		expect(systemMessagesConfigured()).toBe(false);
	});

	test("false when only one of the pair is set", () => {
		process.env.SYSTEM_SPACE = SPACE;
		expect(systemMessagesConfigured()).toBe(false);

		delete process.env.SYSTEM_SPACE;
		process.env.SYSTEM_CHANNEL = CHANNEL;
		expect(systemMessagesConfigured()).toBe(false);
	});

	test("true when both are set", () => {
		process.env.SYSTEM_SPACE = SPACE;
		process.env.SYSTEM_CHANNEL = CHANNEL;
		expect(systemMessagesConfigured()).toBe(true);
	});
});

describe("sendSystemMessage", () => {
	test("no-op without configuration (returns false, sends nothing)", async () => {
		const { gateway, sent } = makeGateway();

		const ok = await sendSystemMessage(gateway, "hello");

		expect(ok).toBe(false);
		expect(sent.length).toBe(0);
	});

	test("sends a createMessage event to the configured space/channel", async () => {
		process.env.SYSTEM_SPACE = SPACE;
		process.env.SYSTEM_CHANNEL = CHANNEL;
		const { gateway, sent } = makeGateway();

		const ok = await sendSystemMessage(gateway, "capacity alert");

		expect(ok).toBe(true);
		expect(sent.length).toBe(1);
		expect(sent[0]?.spaceDid).toBe(SPACE);
		const event = sent[0]?.event as Event & {
			$type: string;
			room: unknown;
			body: { mimeType: string; data: { $bytes: string } };
			extensions: unknown;
		};
		expect(event.$type).toBe("space.roomy.message.createMessage.v0");
		expect(String(event.room)).toBe(CHANNEL);
		expect(event.body.mimeType).toBe("text/markdown");
		// toBytes yields the JSON bytes form: { $bytes: "<padded base64>" }.
		const data = event.body.data as { $bytes: string };
		expect(data.$bytes).toBe(btoa("capacity alert"));
		expect(event.extensions).toEqual({});
	});

	test("sendEvent failure is swallowed (returns false, no throw)", async () => {
		process.env.SYSTEM_SPACE = SPACE;
		process.env.SYSTEM_CHANNEL = CHANNEL;
		const gateway: RoomyGateway = {
			sendEvent: async () => {
				throw new Error("XRPC failed (503)");
			},
			sendEvents: async () => {},
			getSidebar: async () => ({ categories: [] }),
			getRoomMessages: async () => ({ messages: [] }),
			subscribe: async () => {},
			unsubscribe: async () => {},
			disconnectAll: async () => {},
		};

		const ok = await sendSystemMessage(gateway, "capacity alert");

		expect(ok).toBe(false);
	});
});
