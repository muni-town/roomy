/**
 * Per-guild capacity enforcement for bridged spaces: the free-tier floor
 * every space gets, plus any Roomy Pro bridge-token capacity on top.
 *
 * The bridge queries `space.roomy.admin.getSpaceMembership` (appserver) with
 * the bridged guild's current member count. The appserver answers whether
 * the space is over its token capacity.
 *
 * Enforcement policy (two thresholds):
 * - Over the capacity threshold (`overLimit`, memberCount > maxMembers):
 *   sync CONTINUES, but admins are notified (system message) — the bridge is
 *   at risk, not yet paused.
 * - At the hard-stop threshold (`hardStop`, memberCount >= 2x maxMembers):
 *   ALL sync for that (guild, space) tuple halts and resumes automatically
 *   once a later check finds the member count back under 2x capacity.
 *
 * Decision caching: one decision per (guild, space) with a 300s TTL. The
 * gate path (message ingestion, room creation, profile sync) hits the cache;
 * the sweep and member-change triggers force a refresh.
 *
 * Capacity floor (free tier): the appserver always reports at least the
 * free-tier capacity, so every bridged space enforces a limit — a grant-less
 * space hard-stops at 2x the free-tier capacity (100 members), a Pro-granted
 * space at 2x its granted capacity (2000 for the default 1000).
 *
 * Failure semantics (fail-safe, never fail-closed on transient errors):
 * - `stale` response (Polar unreachable, appserver served cached state):
 *   keep the previous decision.
 * - XRPC error (network, 401/403, 404): keep the previous decision.
 * - Member count unavailable: keep the previous decision.
 * - No previous decision in any of those cases: fall back to enabled
 *   (fail-open) and log — a transient error must not halt a healthy bridge.
 * - 503 (billing not configured): treated as enabled — there is no capacity
 *   to enforce.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("capacity");

/** Default decision cache TTL: 300s per the capacity contract. */
export const CAPACITY_TTL_MS = 300_000;

/** Multiplier of maxMembers at which bridging is hard-stopped. */
export const HARD_STOP_MULTIPLIER = 2;

export type TokenStatus = "pending" | "spent";

export interface SpaceMembershipToken {
	grantorDid: string;
	capacity: number;
	status: TokenStatus;
	live: boolean;
}

/** Response shape of `space.roomy.admin.getSpaceMembership`. */
export interface SpaceMembership {
	spaceDid: string;
	tokens: SpaceMembershipToken[];
	validTokenCount: number;
	maxMembers: number;
	memberCount: number;
	overLimit: boolean;
	stale: boolean;
	checkedAt: number;
}

/** A cached/derived decision for one (guild, space) tuple. */
export interface CapacityDecision {
	guildId: string;
	spaceDid: string;
	memberCount: number;
	maxMembers: number;
	overLimit: boolean;
	/** Derived: memberCount >= 2x maxMembers while over the limit — the
	 *  hard-stop threshold at which bridging is actually halted. */
	hardStop: boolean;
	stale: boolean;
	checkedAt: number;
	/** Derived: sync is allowed for this tuple. */
	enabled: boolean;
}

/** Supplies the bridged guild's current member count. */
export interface MemberCountProvider {
	getMemberCount(guildId: string): Promise<number | undefined>;
}

/** Queries the appserver for space membership. */
export interface MembershipClient {
	getSpaceMembership(
		spaceId: string,
		memberCount: number,
	): Promise<SpaceMembership>;
}

/** Gate consulted by sync paths; never throws. */
export interface CapacityGate {
	isEnabled(guildId: string, spaceDid: string): Promise<boolean>;
}

// ─── Module-level gate ──────────────────────────────────────────────────
//
// Sync services (message-ingestion, room-sync, profile-sync, backfill) read
// the gate through getCapacityGate() so their signatures stay unchanged and
// existing tests keep passing with the default always-enabled gate. index.ts
// installs the live CapacityService; tests install a mock.

const ALWAYS_ENABLED: CapacityGate = { isEnabled: async () => true };

let activeGate: CapacityGate = ALWAYS_ENABLED;

export function setCapacityGate(gate: CapacityGate): void {
	activeGate = gate;
}

export function getCapacityGate(): CapacityGate {
	return activeGate;
}

/** Restore the default always-enabled gate. Test-only. */
export function resetCapacityGate(): void {
	activeGate = ALWAYS_ENABLED;
}

// ─── Service ───────────────────────────────────────────────────────────

export interface CapacityServiceOptions {
	/** Decision cache TTL in ms. Default 300s. */
	ttlMs?: number;
	/** Ops kill switch (BRIDGE_CAPACITY_KILL_SWITCH): when true, capacity
	 *  enforcement is disabled globally — every (guild, space) passes.
	 *  Emergency manual re-enable; no XRPC checks are performed. */
	killSwitch?: boolean;
	/** Called on every decision whose `enabled` differs from the previous
	 *  decision (including the first decision for a tuple). Used for the
	 *  owner DM and structured state-change logging. */
	onStateChange?: (
		decision: CapacityDecision,
		previous: CapacityDecision | undefined,
	) => void;
	/** Called whenever the usage state changes: the bridge crossing over
	 *  the capacity threshold (`overLimit` flips) or crossing the hard-stop
	 *  threshold (`hardStop` flips), including the first decision for a
	 *  tuple. Used for the admin system-channel notification. */
	onUsageChange?: (
		decision: CapacityDecision,
		previous: CapacityDecision | undefined,
	) => void;
}

export class CapacityService implements CapacityGate {
	#client: MembershipClient;
	#memberCount: MemberCountProvider;
	#ttlMs: number;
	#killSwitch: boolean;
	#killSwitchLogged = false;
	#onStateChange?: CapacityServiceOptions["onStateChange"];
	#onUsageChange?: CapacityServiceOptions["onUsageChange"];
	#cache = new Map<
		string,
		{ decision: CapacityDecision; expiresAt: number }
	>();

	constructor(
		client: MembershipClient,
		memberCount: MemberCountProvider,
		opts: CapacityServiceOptions = {},
	) {
		this.#client = client;
		this.#memberCount = memberCount;
		this.#ttlMs = opts.ttlMs ?? CAPACITY_TTL_MS;
		this.#killSwitch = opts.killSwitch ?? false;
		this.#onStateChange = opts.onStateChange;
		this.#onUsageChange = opts.onUsageChange;
	}

	/**
	 * Resolve the current decision for (guild, space). Returns the cached
	 * decision when fresh; otherwise queries the appserver. `force` bypasses
	 * the cache (used by the periodic sweep and member-change triggers).
	 * Never throws.
	 */
	async check(
		guildId: string,
		spaceDid: string,
		opts: { force?: boolean } = {},
	): Promise<CapacityDecision> {
		if (this.#killSwitch) {
			if (!this.#killSwitchLogged) {
				this.#killSwitchLogged = true;
				log.warn(
					"capacity: BRIDGE_CAPACITY_KILL_SWITCH is set — capacity enforcement disabled globally; every bridged space passes",
				);
			}
			return {
				guildId,
				spaceDid,
				memberCount: 0,
				maxMembers: 0,
				overLimit: false,
				hardStop: false,
				stale: false,
				checkedAt: Date.now(),
				enabled: true,
			};
		}

		const key = `${guildId}:${spaceDid}`;
		const cached = this.#cache.get(key);
		if (!opts.force && cached && cached.expiresAt > Date.now()) {
			return cached.decision;
		}

		const memberCount = await this.#memberCount.getMemberCount(guildId);
		if (memberCount === undefined) {
			log.warn(
				`capacity: member count unavailable for guild ${guildId}; keeping previous decision`,
				{ guildId, spaceDid },
			);
			if (cached) return cached.decision;
			return this.#store(
				guildId,
				spaceDid,
				fallbackDecision(guildId, spaceDid, "member count unavailable"),
			);
		}

		let membership: SpaceMembership;
		try {
			membership = await this.#client.getSpaceMembership(
				spaceDid,
				memberCount,
			);
		} catch (err) {
			log.warn(
				`capacity: getSpaceMembership failed for ${spaceDid}; keeping previous decision`,
				{ guildId, spaceDid, error: String(err) },
			);
			if (cached) return cached.decision;
			return this.#store(
				guildId,
				spaceDid,
				fallbackDecision(guildId, spaceDid, "membership query failed"),
			);
		}

		if (membership.stale) {
			log.warn(
				`capacity: stale membership for ${spaceDid} (Polar unreachable); keeping previous decision`,
				{ guildId, spaceDid, memberCount: membership.memberCount },
			);
			if (cached) return cached.decision;
			// No previous decision — the appserver's cached state is all we
			// have; use it rather than failing open.
			return this.#store(guildId, spaceDid, membership);
		}

		return this.#store(guildId, spaceDid, membership);
	}

	/** Gate path: true when sync is allowed for (guild, space). Never throws. */
	async isEnabled(guildId: string, spaceDid: string): Promise<boolean> {
		const decision = await this.check(guildId, spaceDid);
		return decision.enabled;
	}

	#store(
		guildId: string,
		spaceDid: string,
		membership: SpaceMembership,
	): CapacityDecision {
		// Hard-stop only when the appserver reports over the limit AND the
		// member count reaches 2x capacity. Under the limit hardStop is never
		// set; the kill switch and transient errors never reach #store.
		const hardStop =
			membership.overLimit &&
			membership.memberCount >= HARD_STOP_MULTIPLIER * membership.maxMembers;
		const decision: CapacityDecision = {
			guildId,
			spaceDid,
			memberCount: membership.memberCount,
			maxMembers: membership.maxMembers,
			overLimit: membership.overLimit,
			hardStop,
			stale: membership.stale,
			checkedAt: membership.checkedAt,
			enabled: !hardStop,
		};
		const key = `${guildId}:${spaceDid}`;
		const previous = this.#cache.get(key)?.decision;
		this.#cache.set(key, {
			decision,
			expiresAt: Date.now() + this.#ttlMs,
		});

		if (!previous || previous.enabled !== decision.enabled) {
			log.info(
				`capacity: ${decision.enabled ? "enabled" : "disabled"} sync for ${spaceDid} (guild ${guildId})`,
				{
					guildId,
					spaceDid,
					enabled: decision.enabled,
					memberCount: decision.memberCount,
					maxMembers: decision.maxMembers,
					overLimit: decision.overLimit,
					hardStop: decision.hardStop,
				},
			);
			try {
				this.#onStateChange?.(decision, previous);
			} catch (err) {
				log.error(
					`capacity: state-change callback failed for ${spaceDid} (guild ${guildId})`,
					err,
				);
			}
		}

		if (
			decision.overLimit !== (previous?.overLimit ?? false) ||
			decision.hardStop !== (previous?.hardStop ?? false)
		) {
			try {
				this.#onUsageChange?.(decision, previous);
			} catch (err) {
				log.error(
					`capacity: usage-change callback failed for ${spaceDid} (guild ${guildId})`,
					err,
				);
			}
		}
		return decision;
	}
}

/** Fail-open decision used when no previous decision exists and the check
 *  could not complete (member count unavailable or XRPC failure). */
function fallbackDecision(
	guildId: string,
	spaceDid: string,
	reason: string,
): SpaceMembership {
	log.warn(
		`capacity: no previous decision for ${spaceDid} (guild ${guildId}); failing open (${reason})`,
		{ guildId, spaceDid, reason },
	);
	return {
		spaceDid,
		tokens: [],
		validTokenCount: 0,
		maxMembers: 0,
		memberCount: 0,
		overLimit: false,
		stale: false,
		checkedAt: Date.now(),
	};
}
