/**
 * Unit tests for the capacity decision service (Roomy Pro bridge tokens).
 *
 * Covers: over/under limit decisions, unprovisioned spaces (no grants)
 * failing open, ops kill switch, stale-keeps-previous, TTL expiry,
 * member-count/XRPC failure keeps previous, state-change callback, force
 * refresh, and the module-level gate singleton.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	CAPACITY_TTL_MS,
	CapacityService,
	getCapacityGate,
	setCapacityGate,
	type CapacityDecision,
	type MemberCountProvider,
	type MembershipClient,
	type SpaceMembership,
	type SpaceMembershipToken,
} from "./capacity.ts";

const GUILD = "guild-1";
const SPACE = "did:web:space-a.example";

function token(over: Partial<SpaceMembershipToken> = {}): SpaceMembershipToken {
	return {
		grantorDid: "did:plc:grantor-1",
		capacity: 100,
		status: "pending",
		live: true,
		...over,
	};
}

function membership(over: Partial<SpaceMembership> = {}): SpaceMembership {
	return {
		spaceDid: SPACE,
		tokens: [],
		validTokenCount: 0,
		maxMembers: 100,
		memberCount: 50,
		overLimit: false,
		stale: false,
		checkedAt: Date.now(),
		...over,
	};
}

function makeClient(responses: SpaceMembership[] = []): MembershipClient & {
	calls: Array<{ spaceId: string; memberCount: number }>;
} {
	const calls: Array<{ spaceId: string; memberCount: number }> = [];
	return {
		calls,
		async getSpaceMembership(spaceId, memberCount) {
			calls.push({ spaceId, memberCount });
			const next = responses.shift();
			if (!next) throw new Error("unexpected getSpaceMembership call");
			return next;
		},
	};
}

function makeMemberCount(count: number | undefined): MemberCountProvider & {
	calls: number;
} {
	let calls = 0;
	return {
		calls: 0,
		async getMemberCount() {
			calls++;
			(this as { calls: number }).calls = calls;
			return count;
		},
	};
}

function makeService(
	client: MembershipClient,
	memberCount: MemberCountProvider,
	onStateChange?: (d: CapacityDecision, p: CapacityDecision | undefined) => void,
): CapacityService {
	return new CapacityService(client, memberCount, { onStateChange });
}

describe("CapacityService decisions", () => {
	test("over limit with grants → disabled", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
		expect(decision.overLimit).toBe(true);
		expect(decision.memberCount).toBe(150);
		expect(decision.maxMembers).toBe(100);
		expect(client.calls).toEqual([{ spaceId: SPACE, memberCount: 150 }]);
	});

	test("under limit → enabled", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(false);
	});

	test("over limit with no grants fails open (unprovisioned space)", async () => {
		const client = makeClient([
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(false);

		// The fail-open decision is cached like any other: no re-query.
		await service.check(GUILD, SPACE);
		expect(client.calls.length).toBe(1);
	});

	test("kill switch forces enabled without consulting client or member count", async () => {
		const client = makeClient([]);
		const memberCount = makeMemberCount(150);
		const service = new CapacityService(client, memberCount, {
			killSwitch: true,
		});

		expect(await service.check(GUILD, SPACE)).toMatchObject({
			enabled: true,
		});
		expect(client.calls.length).toBe(0);
		expect(memberCount.calls).toBe(0);
	});

	test("isEnabled reflects the decision", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150));

		expect(await service.isEnabled(GUILD, SPACE)).toBe(false);
	});
});

describe("CapacityService stale handling", () => {
	test("stale keeps previous enabled decision", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				stale: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		// Second check: stale response — keep the previous (enabled) decision.
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
		expect(second.overLimit).toBe(false);
		expect(client.calls.length).toBe(2);
	});

	test("stale keeps previous disabled decision", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false, stale: true }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(false);

		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(false);
	});

	test("stale with no previous decision uses the stale data", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				stale: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
		expect(decision.stale).toBe(true);
	});
});

describe("CapacityService TTL", () => {
	test("cached decision returned within TTL (no re-query)", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		await service.check(GUILD, SPACE);
		const second = await service.check(GUILD, SPACE);

		expect(second.enabled).toBe(true);
		expect(client.calls.length).toBe(1);
	});

	test("re-queries after TTL expiry", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = new CapacityService(client, makeMemberCount(150), {
			ttlMs: 1,
		});

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		await new Promise((r) => setTimeout(r, 5));
		const second = await service.check(GUILD, SPACE);

		expect(second.enabled).toBe(false);
		expect(client.calls.length).toBe(2);
	});

	test("force bypasses the cache", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		await service.check(GUILD, SPACE);
		await service.check(GUILD, SPACE, { force: true });

		expect(client.calls.length).toBe(2);
	});
});

describe("CapacityService failure handling", () => {
	test("member count unavailable keeps previous decision", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		// Mutable count: available for the first check, then unavailable.
		let count: number | undefined = 50;
		const memberCount: MemberCountProvider = {
			async getMemberCount() {
				return count;
			},
		};
		const service = makeService(client, memberCount);

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);
		expect(client.calls.length).toBe(1);

		// Member count now unavailable — keep previous (enabled) decision.
		count = undefined;
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
		expect(client.calls.length).toBe(1);
	});

	test("member count unavailable with no previous decision fails open", async () => {
		const service = makeService(makeClient([]), makeMemberCount(undefined));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
	});

	test("XRPC error keeps previous decision", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		// Second call: client throws (e.g. 401/403/404/network) — keep previous.
		const failing = makeClient([]);
		failing.getSpaceMembership = async () => {
			throw new Error("XRPC failed (503)");
		};
		const service2 = makeService(failing, makeMemberCount(50));
		// Seed the cache via the first service's decision? No — use the same
		// service instance with a client that starts failing.
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
	});

	test("XRPC error with no previous decision fails open", async () => {
		const failing = makeClient([]);
		failing.getSpaceMembership = async () => {
			throw new Error("XRPC failed (401)");
		};
		const service = makeService(failing, makeMemberCount(50));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
	});
});

describe("CapacityService state-change callback", () => {
	let changes: Array<{ enabled: boolean; previous?: boolean }>;

	beforeEach(() => {
		changes = [];
	});

	test("fires on enabled→disabled and disabled→enabled transitions", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50), (d, p) => {
			changes.push({ enabled: d.enabled, previous: p?.enabled });
		});

		await service.check(GUILD, SPACE); // enabled (first decision)
		await service.check(GUILD, SPACE, { force: true }); // disabled
		await service.check(GUILD, SPACE, { force: true }); // enabled again

		expect(changes).toEqual([
			{ enabled: true, previous: undefined },
			{ enabled: false, previous: true },
			{ enabled: true, previous: false },
		]);
	});

	test("does not fire when the decision is unchanged", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({ memberCount: 60, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(60), (d, p) => {
			changes.push({ enabled: d.enabled, previous: p?.enabled });
		});

		await service.check(GUILD, SPACE);
		await service.check(GUILD, SPACE, { force: true });

		expect(changes).toEqual([{ enabled: true, previous: undefined }]);
	});

	test("callback throw does not break the decision flow", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150), () => {
			throw new Error("callback boom");
		});

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
	});
});

describe("capacity gate singleton", () => {
	afterEach(() => {
		setCapacityGate({ isEnabled: async () => true });
	});

	test("default gate is always enabled", async () => {
		expect(await getCapacityGate().isEnabled(GUILD, SPACE)).toBe(true);
	});

	test("setCapacityGate installs a custom gate", async () => {
		const gate = { isEnabled: vi.fn(async () => false) };
		setCapacityGate(gate);

		expect(await getCapacityGate().isEnabled(GUILD, SPACE)).toBe(false);
		expect(gate.isEnabled).toHaveBeenCalledWith(GUILD, SPACE);
	});
});

describe("CapacityService TTL constant", () => {
	test("default TTL is 300s per the contract", () => {
		expect(CAPACITY_TTL_MS).toBe(300_000);
	});
});
