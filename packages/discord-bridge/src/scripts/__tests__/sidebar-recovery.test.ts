/**
 * Unit tests for the sidebar structure-sync recovery classifier
 * (sidebar-recovery.ts, TASK-181 follow-up).
 *
 * Covers: untouched (revert candidate), edited-after-sync (leave),
 * pre-sync snapshot sources (human edits, v0 events, none), applied-but-
 * unmarked crash window, unapplied claims, multi-sync attribution, and
 * timestamp fallback when the bridge DID is unavailable.
 */

import { describe, expect, test } from "bun:test";
import { encode } from "@atcute/cbor";
import {
	newUlid,
	updateSidebarEvents,
	type SidebarCategory as SdkSidebarCategory,
} from "@roomy-space/sdk";
import {
	analyzeStructureSync,
	decodeSidebarWrite,
	type SidebarEventRow,
	type StructureSyncRow,
} from "../sidebar-recovery.ts";

const BRIDGE_DID = "did:plc:bridge-account";
const HUMAN_DID = "did:plc:someone-admin";

/** Epoch ms for synthetic rows. Sync happens at T; applied_at = T + 2s. */
const T = 1_700_000_000_000;

interface Cat {
	id?: string;
	name: string;
	children?: string[];
}

function v1(categories: Cat[], idx: number, user: string, createdAt: number): SidebarEventRow {
	return {
		idx,
		user,
		created_at: createdAt,
		payload: encode({
			$type: "space.roomy.space.updateSidebar.v1",
			id: newUlid(),
			categories,
		}),
	};
}

function v0(categories: Cat[], idx: number, user: string, createdAt: number): SidebarEventRow {
	return {
		idx,
		user,
		created_at: createdAt,
		payload: encode({
			$type: "space.roomy.space.updateSidebar.v0",
			categories,
		}),
	};
}

function appliedSync(spaceDid = "did:plc:test-space"): StructureSyncRow {
	return {
		guildId: "guild-1",
		spaceDid,
		claimedAt: T - 60_000,
		appliedAt: T + 2_000,
	};
}

const SEEDED = [{ name: "general", children: ["01H"] }];
const SYNCED = [
	{ name: "General", children: ["01A"] },
	{ name: "games", children: ["01B", "01C"] },
];

describe("analyzeStructureSync — happy paths", () => {
	test("untouched: sync is the latest sidebar change, pre-sync snapshot restored", () => {
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
		];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("untouched");
		expect(a.syncEvent?.idx).toBe(1);
		expect(a.preSyncCategories).toEqual([{ name: "general", children: ["01H"] }]);
		expect(a.currentCategories).toEqual(SYNCED);
		expect(a.humanEdits).toEqual([]);
	});

	test("edited: human sidebar write after the sync → leave it", () => {
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
			v1(
				[{ name: "General", children: ["01A", "01B", "01C", "01D"] }],
				2,
				HUMAN_DID,
				T + 3_600_000,
			),
		];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("edited");
		expect(a.humanEdits.map((w) => w.idx)).toEqual([2]);
		expect(a.preSyncCategories).toEqual(SEEDED);
	});

	test("edited-before-sync: last human write before the sync is the restore target", () => {
		const humanLayout = [
			{ name: "mods", children: ["01E"] },
			{ name: "general", children: ["01H"] },
		];
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 172_800_000),
			v1(humanLayout, 1, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 2, BRIDGE_DID, T),
		];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("untouched");
		expect(a.preSyncCategories).toEqual(humanLayout);
	});
});

describe("analyzeStructureSync — marker edge cases", () => {
	test("applied-but-unmarked: applied_at null but bridge write exists (crash between send and mark)", () => {
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
		];
		const sync = { ...appliedSync(), appliedAt: null };
		const a = analyzeStructureSync(writes, sync, BRIDGE_DID);

		expect(a.status).toBe("untouched");
		expect(a.appliedButUnmarked).toBe(true);
		expect(a.syncEvent?.idx).toBe(1);
	});

	test("unapplied: claim only, nothing written, nothing to revert", () => {
		const sync = { ...appliedSync(), appliedAt: null };
		const a = analyzeStructureSync([], sync, BRIDGE_DID);

		expect(a.status).toBe("unapplied");
		expect(a.syncEvent).toBeUndefined();
	});

	test("no-sync-event: applied_at set but no bridge-authored sidebar write exists", () => {
		const writes = [v1(SEEDED, 0, HUMAN_DID, T - 86_400_000)];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("no-sync-event");
		expect(a.syncEvent).toBeUndefined();
	});
});

describe("analyzeStructureSync — multi-sync", () => {
	test("second guild's sync on the same space → multi-sync, manual review", () => {
		// Two bridges synced the same space; this row's applied_at matches
		// the second write (later in time).
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T - 3_600_000), // first guild
			v1(
				[
					{ name: "General", children: ["01A"] },
					{ name: "games", children: ["01B"] },
					{ name: "voice", children: ["01C"] },
				],
				2,
				BRIDGE_DID,
				T,
			), // this guild's sync
		];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("multi-sync");
		expect(a.syncEvent?.idx).toBe(2);
		expect(a.laterBridgeWrites.map((w) => w.idx)).toEqual([1]);
	});
});

describe("analyzeStructureSync — snapshot sources", () => {
	test("no pre-sync write: restore target is an empty sidebar", () => {
		const writes = [v1(SYNCED, 0, BRIDGE_DID, T)];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("untouched");
		expect(a.preSyncCategories).toEqual([]);
	});

	test("deprecated v0 pre-sync write decodes without ids", () => {
		const writes = [
			v0(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
		];
		const a = analyzeStructureSync(writes, appliedSync(), BRIDGE_DID);

		expect(a.status).toBe("untouched");
		expect(a.preSyncCategories).toEqual([{ name: "general", children: ["01H"] }]);
	});
});

describe("analyzeStructureSync — timestamp fallback", () => {
	test("without bridge DID, sync found by created_at ≤ applied_at", () => {
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
		];
		const a = analyzeStructureSync(writes, appliedSync());

		expect(a.status).toBe("untouched");
		expect(a.syncEvent?.idx).toBe(1);
	});

	test("without bridge DID and no event before applied_at → no-sync-event", () => {
		const writes = [v1(SEEDED, 0, HUMAN_DID, T - 86_400_000)];
		const a = analyzeStructureSync(writes, appliedSync());

		expect(a.status).toBe("no-sync-event");
	});

	test("without bridge DID, later writes classify as edited", () => {
		const writes = [
			v1(SEEDED, 0, HUMAN_DID, T - 86_400_000),
			v1(SYNCED, 1, BRIDGE_DID, T),
			v1([{ name: "General", children: ["01A", "01B"] }], 2, HUMAN_DID, T + 3_600_000),
		];
		const a = analyzeStructureSync(writes, appliedSync());

		expect(a.status).toBe("edited");
	});
});

describe("decodeSidebarWrite", () => {
	test("round-trips an SDK-generated updateSidebarEvents event", () => {
		const categories: SdkSidebarCategory[] = [
			{ id: newUlid(), name: "general", children: [newUlid()] },
		];
		const event = updateSidebarEvents(categories);
		const row: SidebarEventRow = {
			idx: 7,
			user: BRIDGE_DID,
			created_at: T,
			payload: encode(event),
		};
		const decoded = decodeSidebarWrite(row);

		expect(decoded.idx).toBe(7);
		expect(decoded.hasIds).toBe(true);
		expect(decoded.categories).toEqual(categories);
	});

	test("malformed payload yields empty categories, not a crash", () => {
		const row: SidebarEventRow = {
			idx: 8,
			user: BRIDGE_DID,
			created_at: T,
			payload: encode({ $type: "space.roomy.message.createMessage.v0" }),
		};
		expect(decodeSidebarWrite(row).categories).toEqual([]);
	});
});
