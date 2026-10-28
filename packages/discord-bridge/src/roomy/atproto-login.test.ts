import { describe, expect, test } from "bun:test";
import {
	type LoginTarget,
	loginBridgeAccount,
	looksLikeAppPassword,
	resolveLoginService,
} from "./atproto-login.ts";

const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

function target(
	login: LoginTarget["login"],
	did: string | undefined = "did:plc:example",
): LoginTarget {
	return {
		login,
		did,
		session: { handle: "bridge.example" },
		serviceUrl: new URL("https://pds.example"),
	};
}

describe("looksLikeAppPassword", () => {
	test("accepts four 4-character groups", () => {
		expect(looksLikeAppPassword(APP_PASSWORD)).toBe(true);
	});

	test("rejects a password with surrounding whitespace or quotes", () => {
		expect(looksLikeAppPassword(`${APP_PASSWORD}\n`)).toBe(false);
		expect(looksLikeAppPassword(`"${APP_PASSWORD}"`)).toBe(false);
	});

	test("rejects an account password", () => {
		expect(looksLikeAppPassword("hunter2")).toBe(false);
	});
});

describe("resolveLoginService", () => {
	test("resolves a DID to its account's PDS", async () => {
		const service = await resolveLoginService("did:plc:example", async () => {
			return "https://pds.example";
		});
		expect(service).toBe("https://pds.example");
	});

	test("leaves a handle to bsky.social", async () => {
		let asked = false;
		const service = await resolveLoginService("bridge.example", async () => {
			asked = true;
			return "https://pds.example";
		});
		expect(service).toBe("https://bsky.social");
		expect(asked).toBe(false);
	});

	test("falls back to bsky.social when the DID document cannot be read", async () => {
		const service = await resolveLoginService("did:plc:example", async () => {
			throw new Error("Failed to resolve did:plc:example: 404");
		});
		expect(service).toBe("https://bsky.social");
	});
});

describe("loginBridgeAccount", () => {
	test("trims the stored credentials before sending them", async () => {
		let sent: { identifier: string; password: string } | undefined;
		await loginBridgeAccount(
			target(async (credentials) => {
				sent = credentials;
			}),
			"  did:plc:example\n",
			`${APP_PASSWORD}\n`,
		);
		expect(sent).toEqual({
			identifier: "did:plc:example",
			password: APP_PASSWORD,
		});
	});

	test("names the account and PDS when the password is rejected", async () => {
		const login = loginBridgeAccount(
			target(async () => {
				throw new Error("Invalid identifier or password");
			}),
			"did:plc:example",
			APP_PASSWORD,
		);
		await expect(login).rejects.toThrow(
			"ATProto login rejected for did:plc:example at https://pds.example: Invalid identifier or password",
		);
	});

	test("says when the value is not app-password shaped", async () => {
		const login = loginBridgeAccount(
			target(async () => {
				throw new Error("Invalid identifier or password");
			}),
			"did:plc:example",
			"hunter2",
		);
		await expect(login).rejects.toThrow(
			"not shaped like a Bluesky app password",
		);
	});

	test("does not claim a well-shaped password is malformed", async () => {
		const login = loginBridgeAccount(
			target(async () => {
				throw new Error("Invalid identifier or password");
			}),
			"did:plc:example",
			APP_PASSWORD,
		);
		await expect(login).rejects.not.toThrow(
			"not shaped like a Bluesky app password",
		);
	});
});
