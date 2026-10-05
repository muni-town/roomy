/**
 * Sidebar structure-sync recovery analysis (TASK-181 follow-up).
 *
 * The one-shot Discord structure sync (TASK-140) merged a bridged guild's
 * category layout into the Roomy sidebar of pre-existing bridges, producing
 * duplicated / reorganized sidebars for spaces that were bridged before the
 * feature shipped. Every (guild, space) with an applied `structure_sync`
 * marker in the bridge DB has a single bridge-authored
 * `space.roomy.space.updateSidebar.v1` event in the appserver's event log —
 * the structure-sync write.
 *
 * This module classifies each affected bridge by replaying the space's
 * sidebar-write history:
 *
 *   - `untouched` — no human sidebar edit after the sync write. The
 *     pre-sync sidebar (the last sidebar write before the sync event) is
 *     recoverable from the log, so the sync can be reverted by writing that
 *     snapshot back.
 *   - `edited` — a human authored an `updateSidebar` event after the sync.
 *     The admin owns the layout now; leave it alone.
 *   - `multi-sync` — the space received more than one bridge-authored
 *     sidebar write (e.g. two guilds bridged to one space, or a released
 *     claim re-synced). Reverting one sync cannot be done by simple snapshot
 *     restore; manual review.
 *   - `unapplied` / `no-sync-event` — nothing (or nothing attributable) was
 *     written; nothing to revert.
 *
 * Purely functional: inputs are the two source-of-truth tables (bridge DB
 * `structure_sync` rows and event-log `stream_events` rows), outputs are
 * decisions. No DB, Discord, or XRPC access here — see `recover-sidebar.ts`.
 */

import { decode } from "@atcute/cbor";

/**
 * A `space.roomy.space.updateSidebar.v1` (or deprecated `.v0`) event as stored
 * in the appserver event log (`stream_events`), with its payload decoded.
 */
export interface SidebarWrite {
	idx: number;
	/** Author DID (`stream_events.user`). */
	user: string;
	/**
	 * Epoch ms at insert; may be null for rows written before the column
	 * existed (older than ~2026-09).
	 */
	created_at: number | null;
	/** `true` for updateSidebar.v1 (categories carry stable ids). */
	hasIds: boolean;
	/** Categories in render order. Names unique per snapshot. */
	categories: SidebarCategory[];
}

export interface SidebarCategory {
	/** Stable category id; absent on deprecated v0 writes. */
	id?: string;
	name: string;
	/** Room ULIDs in display order. */
	children: string[];
}

/** A `structure_sync` row from the bridge DB. */
export interface StructureSyncRow {
	guildId: string;
	spaceDid: string;
	claimedAt: number;
	appliedAt: number | null;
}

export type RecoveryStatus =
	| "untouched"
	| "edited"
	| "multi-sync"
	| "unapplied"
	| "no-sync-event";

export interface SyncAnalysis {
	status: RecoveryStatus;
	/** One-line human explanation of the decision. */
	reason: string;
	/** The structure-sync write in the event log, when found. */
	syncEvent?: SidebarWrite;
	/**
	 * The last sidebar write before the sync — the restore target for
	 * `untouched` bridges. Empty array when the space never had a sidebar.
	 */
	preSyncCategories: SidebarCategory[];
	/** The last sidebar write in the log (what the space shows now). */
	currentCategories: SidebarCategory[];
	/** Human-authored sidebar writes after the sync event. */
	humanEdits: SidebarWrite[];
	/** Bridge-authored sidebar writes after the sync event (other syncs). */
	laterBridgeWrites: SidebarWrite[];
	/**
	 * True when `applied_at` was null but a bridge-authored sidebar write was
	 * found after the claim (the write happened, `markStructureSyncApplied`
	 * never did — e.g. a crash between send and mark).
	 */
	appliedButUnmarked: boolean;
}

/**
 * Event types considered sidebar writes, newest format first. The structure
 * sync always writes v1; pre-sync snapshots may predate v1 and be v0.
 */
export const SIDEBAR_EVENT_TYPES: readonly string[] = [
	"space.roomy.space.updateSidebar.v1",
	"space.roomy.space.updateSidebar.v0",
];

/**
 * Tolerance for attributing a bridge-authored sidebar event to a
 * `structure_sync.applied_at` timestamp: the bridge records `applied_at`
 * *after* the appserver has inserted+materialised the event (network RTT +
 * materialization), and host clocks may skew. 10 minutes is far outside
 * either, while still far inside the gap between two genuine syncs.
 */
const ATTRIBUTION_TOLERANCE_MS = 10 * 60 * 1000;

/** Raw `stream_events` row for a sidebar write. */
export interface SidebarEventRow {
	idx: number;
	user: string;
	created_at: number | null;
	payload: Uint8Array;
}

/** Decode one `stream_events` payload into a sidebar-write shape. */
export function decodeSidebarWrite(row: SidebarEventRow): SidebarWrite {
	const decoded: unknown = decode(row.payload);
	let $type: unknown = undefined;
	let rawCategories: unknown = undefined;
	if (typeof decoded === "object" && decoded !== null) {
		if ("$type" in decoded) $type = decoded.$type;
		if ("categories" in decoded) rawCategories = decoded.categories;
	}
	const hasIds = $type === "space.roomy.space.updateSidebar.v1";
	const categories: SidebarCategory[] = [];
	if (Array.isArray(rawCategories)) {
		for (const cat of rawCategories) {
			if (cat === null || typeof cat !== "object") continue;
			const name = "name" in cat && typeof cat.name === "string" ? cat.name : "";
			if (!name) continue;
			const id = hasIds && "id" in cat && typeof cat.id === "string" ? cat.id : undefined;
			const children =
				"children" in cat && Array.isArray(cat.children)
					? cat.children.filter(
							(c: unknown): c is string => typeof c === "string",
						)
					: [];
			categories.push({ ...(id ? { id } : {}), name, children });
		}
	}
	return {
		idx: row.idx,
		user: row.user,
		created_at: row.created_at,
		hasIds,
		categories,
	};
}

/**
 * Classify a (guild, space) structure-sync against the space's sidebar-write
 * history.
 *
 * `writes` MUST be the space's complete sidebar-write history in ascending
 * `idx` order (see `recover-sidebar.ts` — it queries both sidebar event
 * types). `bridgeDid` is the bridge's ATProto DID (the author of the sync
 * write). When omitted, attribution falls back to timestamps and is
 * correspondingly weaker — pass it whenever possible.
 */
export function analyzeStructureSync(
	writes: SidebarEventRow[],
	sync: StructureSyncRow,
	bridgeDid?: string,
): SyncAnalysis {
	const decoded = writes.map(decodeSidebarWrite).sort((a, b) => a.idx - b.idx);
	const bridgeWrites = bridgeDid
		? decoded.filter((w) => w.user === bridgeDid)
		: [];

	// ── Locate the sync write ─────────────────────────────────────────────
	let syncEvent: SidebarWrite | undefined;
	if (bridgeDid) {
		if (bridgeWrites.length === 0) {
			if (sync.appliedAt === null) {
				return {
					status: "unapplied",
					reason:
						"claim never marked applied and the event log has no bridge-authored sidebar " +
						"write for this space — the sync never wrote anything; nothing to revert.",
					preSyncCategories: lastBefore(decoded, Number.MAX_SAFE_INTEGER),
					currentCategories: decoded.at(-1)?.categories ?? [],
					humanEdits: [],
					laterBridgeWrites: [],
					appliedButUnmarked: false,
				};
			}
			return {
				status: "no-sync-event",
				reason:
					`structure_sync applied_at is set (${new Date(sync.appliedAt).toISOString()}) ` +
					"but the event log has no bridge-authored sidebar write for this space. " +
					"Nothing attributable to revert — manual review.",
				preSyncCategories: lastBefore(decoded, Number.MAX_SAFE_INTEGER),
				currentCategories: decoded.at(-1)?.categories ?? [],
				humanEdits: [],
				laterBridgeWrites: [],
				appliedButUnmarked: false,
			};
		}
		syncEvent = bridgeWrites[0]!;
		if (bridgeWrites.length > 1) {
			// Multiple bridge sidebar writes on one space (multiple guilds, or
			// a released claim re-synced). Attribute by timestamp when the
			// event log has them; otherwise the row cannot be tied to one
			// write.
			if (sync.appliedAt !== null) {
				const withTs = bridgeWrites.filter((w) => w.created_at !== null);
				if (withTs.length > 0) {
					const closest = withTs.reduce((best, w) =>
						Math.abs(w.created_at! - sync.appliedAt!) <
						Math.abs(best.created_at! - sync.appliedAt!)
							? w
							: best,
					);
					if (
						Math.abs(closest.created_at! - sync.appliedAt!) <=
						ATTRIBUTION_TOLERANCE_MS
					) {
						syncEvent = closest;
					} else {
						return multiSync(
							decoded,
							`space has ${bridgeWrites.length} bridge-authored sidebar writes and none of their ` +
								"timestamps line up with applied_at; cannot attribute this structure_sync row to a write.",
						);
					}
				} else {
					return multiSync(
						decoded,
						`space has ${bridgeWrites.length} bridge-authored sidebar writes and the event log ` +
							"has no timestamps to attribute applied_at against.",
					);
				}
			} else {
				return multiSync(
					decoded,
					`space has ${bridgeWrites.length} bridge-authored sidebar writes and applied_at is null; ` +
						"cannot attribute the claim to a write.",
				);
			}
		}
	} else if (sync.appliedAt !== null) {
		// No bridge DID: fall back to timestamps. The sync write is the last
		// sidebar write at or before applied_at — and it must be fresh, or the
		// marker cannot be tied to any write at all.
		const withTs = decoded.filter((w) => w.created_at !== null);
		syncEvent = withTs
			.filter(
				(w) =>
					w.created_at! <= sync.appliedAt! &&
					sync.appliedAt! - w.created_at! <= ATTRIBUTION_TOLERANCE_MS,
			)
			.at(-1);
		if (!syncEvent) {
			return {
				status: "no-sync-event",
				reason:
					"applied_at is set but no sidebar write lands near it (and no bridge DID was " +
					"provided to attribute by author). Pass ATPROTO_BRIDGE_DID for a deterministic check.",
				preSyncCategories: lastBefore(decoded, Number.MAX_SAFE_INTEGER),
				currentCategories: decoded.at(-1)?.categories ?? [],
				humanEdits: [],
				laterBridgeWrites: [],
				appliedButUnmarked: false,
			};
		}
	} else {
		// Claimed but never marked applied, and we cannot attribute by author.
		return {
			status: "unapplied",
			reason:
				"no applied_at and no bridge DID to check the event log against; pass " +
				"ATPROTO_BRIDGE_DID to detect a write that happened but was never marked.",
			preSyncCategories: lastBefore(decoded, Number.MAX_SAFE_INTEGER),
			currentCategories: decoded.at(-1)?.categories ?? [],
			humanEdits: [],
			laterBridgeWrites: [],
			appliedButUnmarked: false,
		};
	}

	const appliedButUnmarked = sync.appliedAt === null;
	const otherBridgeWrites = bridgeDid
		? decoded.filter(
				(w) => w.user === bridgeDid && w.idx !== syncEvent.idx,
			)
		: [];
	const after = decoded.filter((w) => w.idx > syncEvent.idx);
	// With a bridge DID, `after` can only contain human writes at this point
	// (any other bridge write already returned multi-sync above). Without
	// one, treat everything after as a human edit — the safe direction.
	const humanEdits = after;

	if (otherBridgeWrites.length > 0) {
		return multiSync(
			decoded,
			`space received ${bridgeWrites.length} bridge-authored sidebar writes (idx ${bridgeWrites
				.map((w) => w.idx)
				.join(", ")}), ${syncEvent.idx} attributed to this claim. Reverting one ` +
				"structure sync on a shared space would leave the layout at an intermediate " +
				"merge state — manual review.",
			syncEvent,
			otherBridgeWrites,
		);
	}

	const status: RecoveryStatus =
		humanEdits.length > 0 ? "edited" : "untouched";
	const preSyncCategories = lastBefore(decoded, syncEvent.idx);
	const humanEditSummary =
		humanEdits.length > 0
			? `${humanEdits.length} human sidebar write${
					humanEdits.length > 1 ? "s" : ""
				} after the sync (idx ${humanEdits.map((w) => w.idx).join(", ")})`
			: "no human sidebar writes after the sync";
	const reason =
		status === "untouched"
			? `sync write at idx ${syncEvent.idx} (${
					syncEvent.created_at === null
						? "(no timestamp)"
						: new Date(syncEvent.created_at).toISOString()
				}) is the latest sidebar change; ` +
				`revert restores the ${preSyncCategories.length}-category pre-sync sidebar.`
			: `sync write at idx ${syncEvent.idx} (${
					syncEvent.created_at === null
						? "(no timestamp)"
						: new Date(syncEvent.created_at).toISOString()
				}), then ${humanEditSummary} — ` +
				"the space's admins own the layout now; leave it.";

	return {
		status,
		reason,
		syncEvent,
		preSyncCategories,
		currentCategories: decoded.at(-1)?.categories ?? [],
		humanEdits,
		laterBridgeWrites: otherBridgeWrites,
		appliedButUnmarked,
	};
}

function multiSync(
	decoded: SidebarWrite[],
	reason: string,
	syncEvent?: SidebarWrite,
	otherBridgeWrites: SidebarWrite[] = [],
): SyncAnalysis {
	return {
		status: "multi-sync",
		reason,
		...(syncEvent ? { syncEvent } : {}),
		preSyncCategories: lastBefore(
			decoded,
			syncEvent?.idx ?? Number.MAX_SAFE_INTEGER,
		),
		currentCategories: decoded.at(-1)?.categories ?? [],
		humanEdits: [],
		laterBridgeWrites: otherBridgeWrites,
		appliedButUnmarked: false,
	};
}

/** Last sidebar write strictly before `idx`, or `[]` when none exists. */
function lastBefore(
	decoded: SidebarWrite[],
	idx: number,
): SidebarCategory[] {
	for (let i = decoded.length - 1; i >= 0; i--) {
		if (decoded[i]!.idx < idx) return decoded[i]!.categories;
	}
	return [];
}

