/**
 * XRPC client for `space.roomy.admin.getSpaceMembership`.
 *
 * Uses the untyped `DirectXrpcClient.call` path: the NSID is an admin
 * endpoint with no SDK schema entry, and the bridge must not depend on the
 * SDK schema registry for it. The response is validated against an arktype
 * schema so a contract drift surfaces as a typed error instead of a silent
 * misread.
 *
 * Error mapping (from the appserver contract):
 * - 503 billing not configured → XrpcMembershipError with status 503
 * - 404 unknown space → status 404
 * - 401/403 auth → status 401/403
 * The caller (CapacityService) treats every error as keep-previous-decision
 * except 503, which means "no capacity to enforce" (enabled).
 */

import { type } from "arktype";
import type { transport } from "@roomy-space/sdk";
import type {
	MembershipClient,
	SpaceMembership,
	SpaceMembershipToken,
} from "./capacity.ts";

export const NSID = "space.roomy.admin.getSpaceMembership";

const TokenSchema = type({
	grantorDid: "string",
	capacity: "number",
	status: "'pending' | 'spent'",
	live: "boolean",
});
const MembershipSchema = type({
	spaceDid: "string",
	tokens: TokenSchema.array(),
	validTokenCount: "number",
	maxMembers: "number",
	memberCount: "number",
	overLimit: "boolean",
	stale: "boolean",
	checkedAt: "number",
});

/** Error thrown when the appserver rejects the membership query. */
export class XrpcMembershipError extends Error {
	readonly status: number;
	readonly errorType: string | undefined;

	constructor(message: string, status: number, errorType?: string) {
		super(message);
		this.name = "XrpcMembershipError";
		this.status = status;
		this.errorType = errorType;
	}
}

export class XrpcMembershipClient implements MembershipClient {
	#xrpc: transport.DirectXrpcClient;

	constructor(xrpc: transport.DirectXrpcClient) {
		this.#xrpc = xrpc;
	}

	async getSpaceMembership(
		spaceId: string,
		memberCount: number,
	): Promise<SpaceMembership> {
		let data: unknown;
		try {
			const res = await this.#xrpc.call(NSID, {
				spaceId,
				memberCount: String(memberCount),
			});
			data = res.data;
		} catch (err) {
			const status = (err as { status?: number }).status;
			const errorType = (err as { errorType?: string }).errorType;
			if (typeof status === "number") {
				throw new XrpcMembershipError(
					`${NSID} failed (${status}): ${(err as Error).message}`,
					status,
					errorType,
				);
			}
			throw err;
		}

		const parsed = MembershipSchema(data);
		if (parsed instanceof type.errors) {
			throw new TypeError(
				`Invalid ${NSID} response: ${parsed.summary}`,
			);
		}
		return parsed as SpaceMembership;
	}
}

// Re-exported for tests that want to build token fixtures.
export type { SpaceMembershipToken };
