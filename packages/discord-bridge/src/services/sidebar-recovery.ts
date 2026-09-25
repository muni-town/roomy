/**
 * Classification of structure-sync damage in a space's sidebar.
 *
 * Pure functions over a space's sidebar-write history: no network, no bridge
 * DB. `sidebar-repair.ts` supplies the history it decodes from the space's
 * event log.
 *
 * The one-shot structure sync appends a guild's categories to the sidebar the
 * space already had, matching categories to existing ones by exact name and
 * deciding each channel's placement from that channel alone. Two shapes of
 * collateral damage follow: a guild category whose name differs from an
 * existing one only by case appends a *second* header for the same group, and
 * a channel an admin had moved into another category is placed a second time
 * in its Discord category. Both are visible as an increase in the number of
 * categories carrying a given name, respectively of placements of one room,
 * between the write the sync replaced (the pre-sync write) and the write it
 * sent.
 *
 * `restorable` means: the sync's write is the space's latest sidebar write,
 * the write it replaced is known, and the comparison above found damage. That
 * earlier write is the layout a revert restores, so the classifier only ever
 * proposes a layout some real write in the log already contained.
 */

import {
	newUlid,
	updateSidebarEvents,
	type Event,
	type SidebarCategory as SdkSidebarCategory,
	type Ulid,
} from "@roomy-space/sdk";

/** Sidebar write event types, current first. */
export const SIDEBAR_EVENT_TYPES = [
	"space.roomy.space.updateSidebar.v1",
	"space.roomy.space.updateSidebar.v0",
] as const;

const SIDEBAR_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
	SIDEBAR_EVENT_TYPES,
);

/** A category as a sidebar write carried it. `id` is absent on v0 writes. */
export interface SidebarCategoryView {
	id?: string;
	name: string;
	children: string[];
}

/** One decoded sidebar write from a space's event log. */
export interface SidebarWrite {
	idx: number;
	user: string;
	eventType: string;
	categories: SidebarCategoryView[];
}

/**
 * One `#streamEvents` frame entry. Fields are `unknown` because they come off
 * the wire: {@link parseSidebarWrite} validates the ones it needs.
 */
export interface StreamEventEntry {
	idx?: unknown;
	user?: unknown;
	payload?: unknown;
}

export type RecoveryStatus =
	/** The log holds no sidebar write at all. */
	| "no-sidebar-history"
	/** No sidebar write by the bridge: there is no sync to undo. */
	| "no-sync-write"
	/** The bridge's write is the space's first: no earlier layout to restore. */
	| "no-pre-sync-layout"
	/** A space member wrote the sidebar after the sync; the layout is theirs. */
	| "edited"
	/** The bridge's latest write already restores the pre-sync layout. */
	| "already-recovered"
	/** Several bridge-authored writes, the latest not a revert: review by hand. */
	| "multi-sync"
	/** The sync merged without duplicating a header or a room placement. */
	| "no-damage"
	/** The sync's write is the latest and duplicated something. */
	| "restorable";

/** A category name the sync left with more headers than it found. */
export interface DuplicateHeader {
	name: string;
	before: number;
	after: number;
}

/** A room the sync left placed in more categories than it found. */
export interface DuplicateRoom {
	roomId: string;
	before: number;
	after: number;
}

export interface Damage {
	headers: DuplicateHeader[];
	rooms: DuplicateRoom[];
}

export interface SyncAnalysis {
	status: RecoveryStatus;
	/** One line the report prints verbatim. */
	reason: string;
	/** The bridge's first sidebar write: the structure sync. */
	syncWrite?: SidebarWrite;
	/** The layout the sync overwrote; a revert restores this one. */
	preSyncWrite?: SidebarWrite;
	/** The space's latest sidebar write, whoever sent it. */
	currentWrite?: SidebarWrite;
	/** Sidebar writes after the sync that the bridge did not author. */
	humanWrites: SidebarWrite[];
	/** Bridge-authored sidebar writes after the sync. */
	laterBridgeWrites: SidebarWrite[];
	/** Duplication the sync introduced, empty unless it duplicated something. */
	damage: Damage;
}

export function isSidebarEvent(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const { $type } = payload as { $type?: unknown };
	return typeof $type === "string" && SIDEBAR_EVENT_TYPE_SET.has($type);
}

/**
 * Decode one stream entry. Returns `undefined` for an entry that is not a
 * sidebar write; throws for a sidebar write whose shape is unreadable, because
 * a gap in the history would silently misjudge every later write.
 */
export function parseSidebarWrite(
	entry: StreamEventEntry,
): SidebarWrite | undefined {
	if (!isSidebarEvent(entry.payload)) return undefined;
	const { idx, user } = entry;
	if (typeof idx !== "number") {
		throw new Error("sidebar write entry has no numeric idx");
	}
	if (typeof user !== "string") {
		throw new Error(`sidebar write at idx ${idx} has no author DID`);
	}
	const payload = entry.payload as { $type: string; categories?: unknown };
	if (!Array.isArray(payload.categories)) {
		throw new Error(`${payload.$type} at idx ${idx} carries no categories array`);
	}
	return {
		idx,
		user,
		eventType: payload.$type,
		categories: payload.categories.map((raw, i) =>
			parseCategory(raw, `${payload.$type} at idx ${idx}, category ${i}`),
		),
	};
}

function parseCategory(raw: unknown, where: string): SidebarCategoryView {
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`${where}: not an object`);
	}
	const { id, name, children } = raw as {
		id?: unknown;
		name?: unknown;
		children?: unknown;
	};
	if (typeof name !== "string") {
		throw new Error(`${where}: no name`);
	}
	if (
		!Array.isArray(children) ||
		children.some((child) => typeof child !== "string")
	) {
		throw new Error(`${where}: children is not an array of room ids`);
	}
	return {
		...(typeof id === "string" ? { id } : {}),
		name,
		children: children as string[],
	};
}

/**
 * Classify one space's sidebar history against its bridge's DID.
 *
 * Writes are ordered by `idx` before anything else, so callers may pass them
 * in any order.
 */
export function analyzeStructureSync(
	writes: SidebarWrite[],
	bridgeDid: string,
): SyncAnalysis {
	const ordered = [...writes].sort((a, b) => a.idx - b.idx);
	const nothing: SyncAnalysis = {
		status: "no-sidebar-history",
		reason: "no sidebar write in the space's event log",
		humanWrites: [],
		laterBridgeWrites: [],
		damage: emptyDamage(),
	};
	if (ordered.length === 0) return nothing;

	const currentWrite = ordered[ordered.length - 1] as SidebarWrite;
	const bridgeWrites = ordered.filter((write) => write.user === bridgeDid);
	if (bridgeWrites.length === 0) {
		return {
			...nothing,
			status: "no-sync-write",
			reason: `no sidebar write by the bridge (${bridgeDid})`,
			currentWrite,
		};
	}

	const syncWrite = bridgeWrites[0] as SidebarWrite;
	const base = {
		syncWrite,
		currentWrite,
		humanWrites: ordered.filter(
			(write) => write.idx > syncWrite.idx && write.user !== bridgeDid,
		),
		laterBridgeWrites: bridgeWrites.slice(1),
		damage: emptyDamage(),
	};

	const preSyncWrite = lastBefore(ordered, syncWrite.idx);
	if (!preSyncWrite) {
		return {
			...base,
			status: "no-pre-sync-layout",
			reason: "the bridge's write is the space's first sidebar write",
		};
	}

	const damage = diffDamage(preSyncWrite.categories, syncWrite.categories);
	const withLayout = { ...base, preSyncWrite, damage };

	if (base.humanWrites.length > 0) {
		const latest = currentWrite;
		return {
			...withLayout,
			status: "edited",
			reason:
				`${base.humanWrites.length} sidebar write(s) by space members after the sync` +
				` (latest idx ${latest.idx} at ${latest.user})`,
		};
	}

	if (base.laterBridgeWrites.length > 0) {
		const latest = base.laterBridgeWrites[
			base.laterBridgeWrites.length - 1
		] as SidebarWrite;
		if (sameLayout(latest.categories, preSyncWrite.categories)) {
			return {
				...withLayout,
				status: "already-recovered",
				reason: `the bridge's latest sidebar write (idx ${latest.idx}) restores the pre-sync layout`,
			};
		}
		return {
			...withLayout,
			status: "multi-sync",
			reason:
				`${base.laterBridgeWrites.length + 1} bridge-authored sidebar writes; ` +
				`the latest (idx ${latest.idx}) is not a revert of the sync`,
		};
	}

	if (damage.headers.length === 0 && damage.rooms.length === 0) {
		return {
			...withLayout,
			status: "no-damage",
			reason: "the sync merged without duplicating a header or a room placement",
		};
	}

	return {
		...withLayout,
		status: "restorable",
		reason:
			`the sync's write (idx ${syncWrite.idx}) is the latest sidebar change and duplicated ` +
			`${describeDamage(damage)}`,
	};
}

export function emptyDamage(): Damage {
	return { headers: [], rooms: [] };
}

/** Duplication the sync introduced: counts that only grew from `before` onwards. */
export function diffDamage(
	before: SidebarCategoryView[],
	after: SidebarCategoryView[],
): Damage {
	const beforeHeaders = countHeaders(before);
	const afterHeaders = countHeaders(after);
	const beforeRooms = countRooms(before);
	const afterRooms = countRooms(after);
	return {
		headers: [...afterHeaders]
			.map(([key, count]) => ({
				key,
				after: count,
				before: beforeHeaders.get(key) ?? 0,
			}))
			.filter((entry) => entry.before >= 1 && entry.after > entry.before)
			.map((entry) => ({
				name: entry.key,
				before: entry.before,
				after: entry.after,
			})),
		rooms: [...afterRooms]
			.map(([key, count]) => ({
				key,
				after: count,
				before: beforeRooms.get(key) ?? 0,
			}))
			.filter((entry) => entry.before >= 1 && entry.after > entry.before)
			.map((entry) => ({
				roomId: entry.key,
				before: entry.before,
				after: entry.after,
			})),
	};
}

/** Category headers by case-folded name: the sync matches names case-insensitively. */
function countHeaders(categories: SidebarCategoryView[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const category of categories) {
		const key = category.name.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** Room placements across all categories. */
function countRooms(categories: SidebarCategoryView[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const category of categories) {
		for (const roomId of category.children) {
			counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
		}
	}
	return counts;
}

export function describeDamage(damage: Damage): string {
	const parts: string[] = [];
	if (damage.headers.length > 0) {
		parts.push(`a duplicate header for ${damage.headers.map((h) => `"${h.name}"`).join(", ")}`);
	}
	if (damage.rooms.length > 0) {
		parts.push(
			`${damage.rooms.length} room placement(s): ` +
				damage.rooms
					.map((room) => `${room.roomId} ×${room.after} (was ×${room.before})`)
					.join(", "),
		);
	}
	return parts.length > 0 ? parts.join(" and ") : "nothing";
}

/** Whether two layouts list the same categories with the same names and rooms in the same order. */
export function sameLayout(
	a: SidebarCategoryView[],
	b: SidebarCategoryView[],
): boolean {
	if (a.length !== b.length) return false;
	return a.every((category, i) => {
		const other = b[i] as SidebarCategoryView;
		if (category.name !== other.name) return false;
		if (category.children.length !== other.children.length) return false;
		return category.children.every(
			(roomId, j) => roomId === other.children[j],
		);
	});
}

/**
 * Whether a materialized sidebar is the layout a write left behind.
 *
 * `getMetadata` omits channels the caller cannot read and rooms that no longer
 * exist, so the children it reports are an ordered subset of the write's. The
 * category list itself is exact — the handler maps every configured category —
 * so a write that added or lost one is caught here even when its rooms are not
 * comparable.
 */
export function viewMatchesWrite(
	write: SidebarCategoryView[],
	view: SidebarCategoryView[],
): boolean {
	if (write.length !== view.length) return false;
	return write.every((category, i) => {
		const other = view[i] as SidebarCategoryView;
		return (
			category.name === other.name &&
			isOrderedSubset(other.children, category.children)
		);
	});
}

/** Whether `subset`'s entries appear in `superset` in the same relative order. */
function isOrderedSubset(subset: string[], superset: string[]): boolean {
	let from = 0;
	for (const value of subset) {
		const at = superset.indexOf(value, from);
		if (at === -1) return false;
		from = at + 1;
	}
	return true;
}

/**
 * The categories to write to restore `categories`: v1 requires an id per
 * category, and v0 writes carried none, so those get a fresh one. Ids are not
 * part of the layout (`sameLayout` ignores them) — they exist to satisfy the
 * schema and to give clients a stable handle within the write.
 */
export function restoreCategories(
	categories: SidebarCategoryView[],
	nextId: () => Ulid = newUlid,
): SdkSidebarCategory[] {
	return categories.map((category) => ({
		id: (category.id ?? nextId()) as Ulid,
		name: category.name,
		children: category.children as Ulid[],
	}));
}

/**
 * The write that undoes `analysis`: one `updateSidebar.v1` carrying the layout
 * the sync replaced.
 *
 * Only meaningful for a `restorable` analysis. Any other status either has no
 * pre-sync layout to restore (the sync wrote first) or should not be reverted
 * at all (a member has edited the sidebar since, or there is no damage).
 */
export function restoreEvent(analysis: SyncAnalysis): Event {
	const previous = analysis.preSyncWrite;
	if (!previous) {
		throw new Error(
			`nothing to restore: ${analysis.status} (${analysis.reason})`,
		);
	}
	return updateSidebarEvents(restoreCategories(previous.categories));
}

/** The last write before `idx`, or `undefined` when none precedes it. */
function lastBefore(
	ordered: SidebarWrite[],
	idx: number,
): SidebarWrite | undefined {
	let found: SidebarWrite | undefined;
	for (const write of ordered) {
		if (write.idx >= idx) break;
		found = write;
	}
	return found;
}
