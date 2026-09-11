/**
 * Unit tests for XrpcMembershipClient.
 *
 * Covers: the untyped `DirectXrpcClient.call` path (NSID + params), error
 * mapping to XrpcMembershipError (status/errorType), and response-shape
 * validation against the arktype schema.
 */

import { describe, expect, test } from "bun:test";
import {
	NSID,
	XrpcMembershipClient,
	XrpcMembershipError,
} from "../membership-client.ts";

const SPACE = "did:web:space-a.example";

/** Minimal stub of the DirectXrpcClient surface the client uses. */
class StubXrpc {
	calls: Array<{ nsid: string; params: Record<string, string> }> = [];
	response: unknown = {};
	error: unknown;

	async call(
		nsid: string,
		params: Record<string, string>,
	): Promise<{ data: unknown }> {
		this.calls.push({ nsid, params });
		if (this.error) throw this.error;
		return { data: this.response };
	}
}

function validResponse() {
	return {
		spaceDid: SPACE,
		tokens: [
			{
				grantorDid: "did:plc:grantor",
				capacity: 10,
				status: "spent",
				live: true,
			},
		],
		validTokenCount: 1,
		maxMembers: 10,
		memberCount: 5,
		overLimit: false,
		stale: false,
		checkedAt: 1_700_000_000_000,
	};
}

describe("XrpcMembershipClient", () => {
	test("calls the untyped XRPC path with NSID and string params", async () => {
		const xrpc = new StubXrpc();
		xrpc.response = validResponse();
		const client = new XrpcMembershipClient(xrpc as never);

		const result = await client.getSpaceMembership(SPACE, 5);

		expect(xrpc.calls).toEqual([
			{ nsid: NSID, params: { spaceId: SPACE, memberCount: "5" } },
		]);
		expect(result.overLimit).toBe(false);
		expect(result.tokens[0]?.grantorDid).toBe("did:plc:grantor");
	});

	test("maps an XRPC error with status to XrpcMembershipError", async () => {
		const xrpc = new StubXrpc();
		xrpc.error = Object.assign(new Error("Forbidden"), {
			status: 403,
			errorType: "Forbidden",
		});
		const client = new XrpcMembershipClient(xrpc as never);

		await expect(client.getSpaceMembership(SPACE, 5)).rejects.toMatchObject({
			name: "XrpcMembershipError",
			status: 403,
			errorType: "Forbidden",
		});
	});

	test("preserves the 503 status for billing-not-configured", async () => {
		const xrpc = new StubXrpc();
		xrpc.error = Object.assign(new Error("billing not configured"), {
			status: 503,
			errorType: "BillingNotConfigured",
		});
		const client = new XrpcMembershipClient(xrpc as never);

		const err = await client
			.getSpaceMembership(SPACE, 5)
			.then(() => null, (e: unknown) => e);
		expect(err).toBeInstanceOf(XrpcMembershipError);
		expect((err as XrpcMembershipError).status).toBe(503);
	});

	test("rethrows non-XRPC errors unchanged", async () => {
		const xrpc = new StubXrpc();
		xrpc.error = new TypeError("boom");
		const client = new XrpcMembershipClient(xrpc as never);

		await expect(client.getSpaceMembership(SPACE, 5)).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	test("rejects a response that violates the contract shape", async () => {
		const xrpc = new StubXrpc();
		xrpc.response = { spaceDid: SPACE, overLimit: "not-a-boolean" };
		const client = new XrpcMembershipClient(xrpc as never);

		await expect(client.getSpaceMembership(SPACE, 5)).rejects.toBeInstanceOf(
			TypeError,
		);
	});
});
