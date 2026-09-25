import { describe, expect, test } from "bun:test";
import type { Ulid } from "@roomy-space/sdk";
import {
	type SidebarCategoryView,
	type SidebarWrite,
	analyzeStructureSync,
	diffDamage,
	parseSidebarWrite,
	restoreCategories,
	sameLayout,
	viewMatchesWrite,
} from "../sidebar-recovery.ts";

const BRIDGE = "did:plc:bridge";
const ADMIN = "did:plc:admin";

const V1 = "space.roomy.space.updateSidebar.v1";
const V0 = "space.roomy.space.updateSidebar.v0";

function category(
	name: string,
	children: string[] = [],
	id?: string,
): SidebarCategoryView {
	return { ...(id ? { id } : {}), name, children };
}

function write(
	idx: number,
	user: string,
	categories: SidebarCategoryView[],
	eventType = V1,
): SidebarWrite {
	return { idx, user, eventType, categories };
}

describe("parseSidebarWrite", () => {
	test("reads a v1 write", () => {
		const parsed = parseSidebarWrite({
			idx: 7,
			user: ADMIN,
			payload: {
				$type: V1,
				categories: [
					{ id: "cat-1", name: "general", children: ["room-1"] },
				],
			},
		});
		expect(parsed).toEqual({
			idx: 7,
			user: ADMIN,
			eventType: V1,
			categories: [{ id: "cat-1", name: "general", children: ["room-1"] }],
		});
	});

	test("reads a v0 write, which carries no category ids", () => {
		const parsed = parseSidebarWrite({
			idx: 3,
			user: ADMIN,
			payload: {
				$type: V0,
				categories: [{ name: "general", children: [] }],
			},
		});
		expect(parsed?.categories).toEqual([{ name: "general", children: [] }]);
		expect(parsed?.categories[0]).not.toHaveProperty("id");
	});

	test("ignores events that are not sidebar writes", () => {
		expect(
			parseSidebarWrite({
				idx: 1,
				user: ADMIN,
				payload: { $type: "space.roomy.message.createMessage.v0" },
			}),
		).toBeUndefined();
		expect(parseSidebarWrite({ idx: 1, user: ADMIN })).toBeUndefined();
	});

	test("throws on a sidebar write it cannot read, rather than skipping it", () => {
		expect(() =>
			parseSidebarWrite({ idx: 4, user: ADMIN, payload: { $type: V1 } }),
		).toThrow(/idx 4/);
		expect(() =>
			parseSidebarWrite({
				idx: 5,
				user: ADMIN,
				payload: { $type: V1, categories: [{ name: "general" }] },
			}),
		).toThrow(/children/);
		expect(() =>
			parseSidebarWrite({
				idx: 6,
				payload: { $type: V1, categories: [] },
			}),
		).toThrow(/author DID/);
	});
});

describe("analyzeStructureSync", () => {
	test("no sidebar writes at all", () => {
		const analysis = analyzeStructureSync([], BRIDGE);
		expect(analysis.status).toBe("no-sidebar-history");
		expect(analysis.currentWrite).toBeUndefined();
	});

	test("only members have written the sidebar", () => {
		const analysis = analyzeStructureSync(
			[write(1, ADMIN, [category("general")])],
			BRIDGE,
		);
		expect(analysis.status).toBe("no-sync-write");
		expect(analysis.currentWrite?.idx).toBe(1);
	});

	test("the bridge's write is the space's first", () => {
		const analysis = analyzeStructureSync(
			[write(9, BRIDGE, [category("general")])],
			BRIDGE,
		);
		expect(analysis.status).toBe("no-pre-sync-layout");
		expect(analysis.syncWrite?.idx).toBe(9);
	});

	test("restorable: the sync's write is latest and duplicated a header", () => {
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [category("general", ["lobby"])]),
				write(2, BRIDGE, [
					category("general", ["lobby"]),
					category("General", ["chat"]),
				]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("restorable");
		expect(analysis.preSyncWrite?.idx).toBe(1);
		expect(analysis.damage.headers).toEqual([
			{ name: "general", before: 1, after: 2 },
		]);
		expect(analysis.damage.rooms).toEqual([]);
		expect(analysis.reason).toContain("idx 2");
	});

	test("restorable: the sync placed a room a second time", () => {
		// An admin had moved `chat` out of `general`; the sync placed it in its
		// Discord category again while the old placement stayed.
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [
					category("general", ["lobby"]),
					category("off-topic", ["chat"]),
				]),
				write(2, BRIDGE, [
					category("general", ["lobby", "chat"]),
					category("off-topic", ["chat"]),
				]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("restorable");
		expect(analysis.damage.headers).toEqual([]);
		expect(analysis.damage.rooms).toEqual([
			{ roomId: "chat", before: 1, after: 2 },
		]);
	});

	test("a category new to the sidebar is not damage", () => {
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [category("general", ["lobby"])]),
				write(2, BRIDGE, [
					category("general", ["lobby"]),
					category("voice", ["vc-1"]),
				]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("no-damage");
		expect(analysis.damage).toEqual({ headers: [], rooms: [] });
	});

	test("a room the sidebar never had is not damage", () => {
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [category("general", ["lobby"])]),
				write(2, BRIDGE, [category("general", ["lobby", "chat"])]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("no-damage");
	});

	test("a member's write after the sync wins, even with damage present", () => {
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [category("general", ["lobby"])]),
				write(2, BRIDGE, [
					category("general", ["lobby"]),
					category("General", ["chat"]),
				]),
				write(3, ADMIN, [category("general", ["lobby", "chat"])]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("edited");
		expect(analysis.humanWrites.map((entry) => entry.idx)).toEqual([3]);
		expect(analysis.damage.headers).toHaveLength(1);
		expect(analysis.reason).toContain("idx 3");
	});

	test("a second bridge write that restores the pre-sync layout is a no-op", () => {
		const pre = [category("general", ["lobby"])];
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, pre),
				write(2, BRIDGE, [
					category("general", ["lobby"]),
					category("General", ["chat"]),
				]),
				write(3, BRIDGE, [category("general", ["lobby"])]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("already-recovered");
		expect(analysis.preSyncWrite?.idx).toBe(1);
	});

	test("several bridge writes, the latest not a revert", () => {
		const analysis = analyzeStructureSync(
			[
				write(1, ADMIN, [category("general", ["lobby"])]),
				write(2, BRIDGE, [category("general", ["lobby", "chat"])]),
				write(3, BRIDGE, [category("general", ["lobby"]), category("voice")]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("multi-sync");
		expect(analysis.laterBridgeWrites.map((entry) => entry.idx)).toEqual([3]);
	});

	test("orders writes by idx before deciding anything", () => {
		const analysis = analyzeStructureSync(
			[
				write(2, BRIDGE, [category("general", ["lobby"]), category("General")]),
				write(1, ADMIN, [category("general", ["lobby"])]),
			],
			BRIDGE,
		);
		expect(analysis.status).toBe("restorable");
		expect(analysis.syncWrite?.idx).toBe(2);
	});
});

describe("diffDamage", () => {
	test("only counts growth of something that was already there", () => {
		const damage = diffDamage(
			[category("general", ["lobby", "chat"]), category("voice", ["vc"])],
			[
				category("general", ["lobby", "chat", "chat"]),
				category("General", ["lobby", "chat", "chat"]),
				category("voice", ["vc"]),
				category("new", ["other"]),
			],
		);
		expect(damage.headers).toEqual([
			{ name: "general", before: 1, after: 2 },
		]);
		expect(damage.rooms).toEqual([
			{ roomId: "lobby", before: 1, after: 2 },
			{ roomId: "chat", before: 1, after: 4 },
		]);
	});

	test("folds a name's case when comparing headers", () => {
		const damage = diffDamage(
			[category("General")],
			[category("General"), category("general")],
		);
		expect(damage.headers).toEqual([{ name: "general", before: 1, after: 2 }]);
	});
});

describe("sameLayout", () => {
	test("compares names and rooms, ignoring category ids", () => {
		expect(
			sameLayout(
				[category("general", ["lobby"], "id-a")],
				[category("general", ["lobby"], "id-b")],
			),
		).toBe(true);
	});

	test("rejects a different room order, name, or length", () => {
		expect(
			sameLayout(
				[category("general", ["a", "b"])],
				[category("general", ["b", "a"])],
			),
		).toBe(false);
		expect(
			sameLayout([category("general")], [category("General")]),
		).toBe(false);
		expect(
			sameLayout([category("general")], [category("general"), category("x")]),
		).toBe(false);
	});
});

describe("viewMatchesWrite", () => {
	test("accepts a materialized sidebar that dropped unreadable rooms", () => {
		expect(
			viewMatchesWrite(
				[category("general", ["lobby", "secret", "chat"])],
				[category("general", ["lobby", "chat"])],
			),
		).toBe(true);
	});

	test("rejects a reordered, renamed, or resized category list", () => {
		expect(
			viewMatchesWrite(
				[category("general", ["lobby", "chat"])],
				[category("general", ["chat", "lobby"])],
			),
		).toBe(false);
		expect(
			viewMatchesWrite([category("general")], [category("General")]),
		).toBe(false);
		expect(
			viewMatchesWrite(
				[category("general")],
				[category("general"), category("voice")],
			),
		).toBe(false);
	});
});

describe("restoreCategories", () => {
	test("synthesizes an id for a v0 category and keeps a v1 one", () => {
		let counter = 0;
		const restored = restoreCategories(
			[category("general", ["lobby"]), category("voice", [], "existing-id")],
			() => `generated-${(counter += 1)}` as Ulid,
		);
		expect(
			restored.map((entry) => ({
				id: entry.id as string,
				name: entry.name,
				children: [...entry.children] as string[],
			})),
		).toEqual([
			{ id: "generated-1", name: "general", children: ["lobby"] },
			{ id: "existing-id", name: "voice", children: [] },
		]);
	});

	test("gives every category a distinct id", () => {
		const restored = restoreCategories([
			category("general"),
			category("off-topic"),
			category("voice"),
		]);
		const ids = restored.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(3);
	});
});
