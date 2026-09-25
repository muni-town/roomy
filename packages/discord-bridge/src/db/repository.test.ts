import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BridgeRepository } from "./repository.ts";
import { runMigrations } from "./schema.ts";

const SPACE_A = "did:web:space-a.example";
const SPACE_B = "did:web:space-b.example";
const GUILD = "guild-1";

function repo(): BridgeRepository {
	return BridgeRepository.open(":memory:");
}

describe("migrations", () => {
	test("apply cleanly on a fresh database", () => {
		const db = new Database(":memory:");
		const result = runMigrations(db);
		expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(result.current).toBe(9);
	});

	test("are idempotent across re-runs", () => {
		const db = new Database(":memory:");
		const first = runMigrations(db);
		const second = runMigrations(db);
		expect(second.applied).toEqual([]);
		expect(second.current).toBe(9);
	});
});

describe("bridge_config", () => {
	test("upsert and get a single bridge", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		const cfg = r.getBridgeConfig(GUILD, SPACE_A);
		expect(cfg?.mode).toBe("full");
		expect(cfg?.guildId).toBe(GUILD);
		expect(cfg?.spaceDid).toBe(SPACE_A);
	});

	test("supports multiple bridges per guild", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		r.upsertBridgeConfig(GUILD, SPACE_B, "subset");
		const list = r.listBridgeConfigsForGuild(GUILD);
		expect(list.length).toBe(2);
		expect(list.map((c) => c.spaceDid).sort()).toEqual(
			[SPACE_A, SPACE_B].sort(),
		);
	});

	test("upsert flips mode (full → subset preserves allowlist)", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		r.upsertBridgeConfig(GUILD, SPACE_A, "subset");
		expect(r.getBridgeConfig(GUILD, SPACE_A)?.mode).toBe("subset");
		expect(r.isAllowlisted(SPACE_A, "c1")).toBe(true);
	});

	test("removeBridgeConfig cascades to allowlist", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "subset");
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		r.removeBridgeConfig(GUILD, SPACE_A);
		expect(r.getBridgeConfig(GUILD, SPACE_A)).toBeUndefined();
		expect(r.isAllowlisted(SPACE_A, "c1")).toBe(false);
	});

	test("listAllBridgeConfigs returns every bridge", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		r.upsertBridgeConfig("guild-2", SPACE_B, "subset");
		expect(r.listAllBridgeConfigs().length).toBe(2);
	});
});

describe("getTargetSpacesForChannel", () => {
	test("returns empty when no bridges", () => {
		const r = repo();
		expect(r.getTargetSpacesForChannel(GUILD, "c1")).toEqual([]);
	});

	test("includes full bridges regardless of channel", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		expect(r.getTargetSpacesForChannel(GUILD, "any-channel")).toEqual([
			SPACE_A,
		]);
	});

	test("subset bridge requires allowlist entry", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "subset");
		expect(r.getTargetSpacesForChannel(GUILD, "c1")).toEqual([]);
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		expect(r.getTargetSpacesForChannel(GUILD, "c1")).toEqual([SPACE_A]);
		expect(r.getTargetSpacesForChannel(GUILD, "c2")).toEqual([]);
	});

	test("combines full and subset bridges in same guild", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		r.upsertBridgeConfig(GUILD, SPACE_B, "subset");
		r.addToAllowlist(SPACE_B, "c1", GUILD);
		expect(r.getTargetSpacesForChannel(GUILD, "c1").sort()).toEqual(
			[SPACE_A, SPACE_B].sort(),
		);
		expect(r.getTargetSpacesForChannel(GUILD, "c2")).toEqual([SPACE_A]);
	});

	test("does not leak across guilds", () => {
		const r = repo();
		r.upsertBridgeConfig(GUILD, SPACE_A, "full");
		expect(r.getTargetSpacesForChannel("other-guild", "c1")).toEqual([]);
	});
});

describe("id_mappings", () => {
	test("round-trip per space and kind", () => {
		const r = repo();
		r.registerMapping(SPACE_A, "message", "d1", "r1");
		r.registerMapping(SPACE_A, "channel", "d1", "r2");
		expect(r.getRoomyId(SPACE_A, "message", "d1")).toBe("r1");
		expect(r.getRoomyId(SPACE_A, "channel", "d1")).toBe("r2");
		expect(r.getDiscordId(SPACE_A, "message", "r1")).toBe("d1");
	});

	test("same discord id can map to different roomy ids in different spaces", () => {
		const r = repo();
		r.registerMapping(SPACE_A, "message", "d1", "r-a");
		r.registerMapping(SPACE_B, "message", "d1", "r-b");
		expect(r.getRoomyId(SPACE_A, "message", "d1")).toBe("r-a");
		expect(r.getRoomyId(SPACE_B, "message", "d1")).toBe("r-b");
	});

	test("upsert overwrites within the same (space, kind, discord_id)", () => {
		const r = repo();
		r.registerMapping(SPACE_A, "message", "d1", "r1");
		r.registerMapping(SPACE_A, "message", "d1", "r2");
		expect(r.getRoomyId(SPACE_A, "message", "d1")).toBe("r2");
	});

	test("unregister removes only the targeted mapping", () => {
		const r = repo();
		r.registerMapping(SPACE_A, "user", "u1", "did:x");
		r.registerMapping(SPACE_B, "user", "u1", "did:x");
		r.unregisterMapping(SPACE_A, "user", "u1");
		expect(r.getRoomyId(SPACE_A, "user", "u1")).toBeUndefined();
		expect(r.getRoomyId(SPACE_B, "user", "u1")).toBe("did:x");
	});
});

describe("channel_cursors", () => {
	test("set, get, upsert, null cursor", () => {
		const r = repo();
		expect(r.getChannelCursor(SPACE_A, "c1")).toBeUndefined();
		r.setChannelCursor(SPACE_A, "c1", "msg-100");
		expect(r.getChannelCursor(SPACE_A, "c1")?.lastMessageId).toBe("msg-100");
		r.setChannelCursor(SPACE_A, "c1", "msg-200");
		expect(r.getChannelCursor(SPACE_A, "c1")?.lastMessageId).toBe("msg-200");
		r.setChannelCursor(SPACE_A, "c2", null);
		expect(r.getChannelCursor(SPACE_A, "c2")?.lastMessageId).toBeNull();
	});

	test("scoped per (space, channel)", () => {
		const r = repo();
		r.setChannelCursor(SPACE_A, "c1", "msg-A");
		r.setChannelCursor(SPACE_B, "c1", "msg-B");
		expect(r.getChannelCursor(SPACE_A, "c1")?.lastMessageId).toBe("msg-A");
		expect(r.getChannelCursor(SPACE_B, "c1")?.lastMessageId).toBe("msg-B");
	});
});

describe("allowlist", () => {
	test("scoped per (space, channel)", () => {
		const r = repo();
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		expect(r.isAllowlisted(SPACE_A, "c1")).toBe(true);
		expect(r.isAllowlisted(SPACE_B, "c1")).toBe(false);
	});

	test("same channel can be allowlisted in multiple bridges", () => {
		const r = repo();
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		r.addToAllowlist(SPACE_B, "c1", GUILD);
		expect(r.isAllowlisted(SPACE_A, "c1")).toBe(true);
		expect(r.isAllowlisted(SPACE_B, "c1")).toBe(true);
	});

	test("listAllowlistForBridge returns rows for one space only", () => {
		const r = repo();
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		r.addToAllowlist(SPACE_A, "c2", GUILD);
		r.addToAllowlist(SPACE_B, "c1", GUILD);
		const list = r.listAllowlistForBridge(SPACE_A);
		expect(list.length).toBe(2);
		expect(list.map((e) => e.channelId).sort()).toEqual(["c1", "c2"]);
	});

	test("removeFromAllowlist is targeted", () => {
		const r = repo();
		r.addToAllowlist(SPACE_A, "c1", GUILD);
		r.addToAllowlist(SPACE_B, "c1", GUILD);
		r.removeFromAllowlist(SPACE_A, "c1");
		expect(r.isAllowlisted(SPACE_A, "c1")).toBe(false);
		expect(r.isAllowlisted(SPACE_B, "c1")).toBe(true);
	});
});

describe("profile_hashes", () => {
	test("scoped per (space, user)", () => {
		const r = repo();
		expect(r.getProfileHash(SPACE_A, "u1")).toBeUndefined();
		r.setProfileHash(SPACE_A, "u1", "abc");
		r.setProfileHash(SPACE_B, "u1", "xyz");
		expect(r.getProfileHash(SPACE_A, "u1")).toBe("abc");
		expect(r.getProfileHash(SPACE_B, "u1")).toBe("xyz");
		r.setProfileHash(SPACE_A, "u1", "def");
		expect(r.getProfileHash(SPACE_A, "u1")).toBe("def");
	});
});

describe("webhook_tokens", () => {
	test("set, get, delete", () => {
		const r = repo();
		r.setWebhookToken("c1", "wh-id", "wh-token");
		const t = r.getWebhookToken("c1");
		expect(t?.webhookId).toBe("wh-id");
		expect(t?.token).toBe("wh-token");
		r.deleteWebhookToken("c1");
		expect(r.getWebhookToken("c1")).toBeUndefined();
	});

	test("isOurWebhook distinguishes own vs foreign vs unknown", () => {
		const r = repo();
		// No webhooks registered yet — nothing is "ours".
		expect(r.isOurWebhook("wh-id")).toBe(false);

		r.setWebhookToken("c1", "wh-id", "wh-token");
		// Our webhook ID is recognised.
		expect(r.isOurWebhook("wh-id")).toBe(true);
		// A different integration's webhook ID is not ours.
		expect(r.isOurWebhook("other-wh-id")).toBe(false);
		// Empty table edge case (after delete) — must not claim everything.
		r.deleteWebhookToken("c1");
		expect(r.isOurWebhook("wh-id")).toBe(false);
		expect(r.isOurWebhook("anything")).toBe(false);
	});
});

describe("pending_room_creations", () => {
	test("stores and retrieves a pending room creation", () => {
		const r = repo();
		r.storePendingRoomCreation(
			SPACE_A,
			"roomy-thread-1",
			"space.roomy.thread",
			"Test Thread",
			"none",
		);
		const pending = r.getPendingRoomCreation(SPACE_A, "roomy-thread-1");
		expect(pending).toEqual({
			spaceDid: SPACE_A,
			roomyId: "roomy-thread-1",
			kind: "space.roomy.thread",
			name: "Test Thread",
			defaultAccess: "none",
		});
	});

	test("upserts on duplicate roomy id", () => {
		const r = repo();
		r.storePendingRoomCreation(
			SPACE_A,
			"roomy-thread-1",
			"space.roomy.thread",
			"Old Name",
			"readwrite",
		);
		r.storePendingRoomCreation(
			SPACE_A,
			"roomy-thread-1",
			"space.roomy.thread",
			"New Name",
			"none",
		);
		const pending = r.getPendingRoomCreation(SPACE_A, "roomy-thread-1");
		expect(pending?.name).toBe("New Name");
		expect(pending?.defaultAccess).toBe("none");
	});

	test("returns undefined for missing entry", () => {
		const r = repo();
		expect(r.getPendingRoomCreation(SPACE_A, "missing")).toBeUndefined();
	});

	test("delete removes only the targeted entry", () => {
		const r = repo();
		r.storePendingRoomCreation(
			SPACE_A,
			"roomy-thread-1",
			"space.roomy.thread",
			"A",
			undefined,
		);
		r.storePendingRoomCreation(
			SPACE_B,
			"roomy-thread-1",
			"space.roomy.thread",
			"B",
			undefined,
		);
		r.deletePendingRoomCreation(SPACE_A, "roomy-thread-1");
		expect(r.getPendingRoomCreation(SPACE_A, "roomy-thread-1")).toBeUndefined();
		expect(r.getPendingRoomCreation(SPACE_B, "roomy-thread-1")).toBeDefined();
	});

	test("handles undefined defaultAccess", () => {
		const r = repo();
		r.storePendingRoomCreation(
			SPACE_A,
			"roomy-thread-1",
			"space.roomy.thread",
			"Thread",
			undefined,
		);
		const pending = r.getPendingRoomCreation(SPACE_A, "roomy-thread-1");
		expect(pending?.defaultAccess).toBeUndefined();
	});
});

describe("event_errors", () => {
	test("logs and retrieves errors for a space", () => {
		const r = repo();
		r.logEventError(
			SPACE_A,
			42,
			"space.roomy.message.createMessage.v0",
			"boom",
		);
		r.logEventError(SPACE_A, 43, "space.roomy.message.editMessage.v0", "nope");
		r.logEventError(
			SPACE_B,
			1,
			"space.roomy.message.createMessage.v0",
			"other",
		);

		const errors = r.getEventErrors(SPACE_A);
		expect(errors.length).toBe(2);
		expect(errors[0]?.eventIdx).toBe(42);
		expect(errors[0]?.eventType).toBe("space.roomy.message.createMessage.v0");
		expect(errors[0]?.errorMessage).toBe("boom");
		expect(errors[1]?.eventIdx).toBe(43);
	});

	test("filters errors by timestamp", () => {
		const r = repo();
		r.logEventError(SPACE_A, 1, "t", "old");
		// Sleep briefly so timestamps are unambiguous.
		const after = Date.now();
		while (Date.now() <= after) {
			// busy-wait to guarantee next log has a strictly greater timestamp
		}
		r.logEventError(SPACE_A, 2, "t", "new");
		const filtered = r.getEventErrors(SPACE_A, 100, after + 1);
		expect(filtered.length).toBe(1);
		expect(filtered[0]?.errorMessage).toBe("new");
	});
});

describe("structure_sync", () => {
	test("only the first claim wins, scoped per (guild, space)", () => {
		const r = repo();

		expect(r.claimStructureSync(GUILD, SPACE_A)).toBe(true);
		expect(r.claimStructureSync(GUILD, SPACE_A)).toBe(false);
		expect(r.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);
		// A different space, or a different guild, is an independent sync.
		expect(r.claimStructureSync(GUILD, SPACE_B)).toBe(true);
		expect(r.claimStructureSync("guild-2", SPACE_A)).toBe(true);
	});

	test("a released claim can be re-claimed", () => {
		const r = repo();
		r.claimStructureSync(GUILD, SPACE_A);
		expect(r.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);

		r.releaseStructureSync(GUILD, SPACE_A);
		expect(r.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(false);
		expect(r.claimStructureSync(GUILD, SPACE_A)).toBe(true);
	});

	test("an applied claim is never released", () => {
		const r = repo();
		r.claimStructureSync(GUILD, SPACE_A);
		r.markStructureSyncApplied(GUILD, SPACE_A);

		// releaseStructureSync exists only for the no-write path; after a
		// write it must not reopen the sync, or the structure could be
		// applied a second time.
		r.releaseStructureSync(GUILD, SPACE_A);
		expect(r.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);
		expect(r.claimStructureSync(GUILD, SPACE_A)).toBe(false);
	});
});

describe("backfill_progress", () => {
	test("round-trips parentId and windowSynced", () => {
		const r = repo();
		r.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "thread-1",
			guildId: GUILD,
			kind: "thread",
			channelName: "Help thread",
			phase: "phase2",
			messagesSynced: 120,
			messagesSkipped: 4,
			windowBoundary: "900",
			walkCursor: "800",
			parentId: "channel-1",
			windowSynced: 120,
		});

		const row = r.getBackfillProgress(SPACE_A, "thread-1");
		expect(row?.parentId).toBe("channel-1");
		expect(row?.windowSynced).toBe(120);

		const listed = r.listBackfillProgress(SPACE_A);
		expect(listed[0]?.parentId).toBe("channel-1");
		expect(listed[0]?.windowSynced).toBe(120);
	});

	test("later writes without parentId/windowSynced never erase them", () => {
		const r = repo();
		r.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "thread-1",
			guildId: GUILD,
			kind: "thread",
			channelName: "Help thread",
			phase: "phase2",
			messagesSynced: 120,
			messagesSkipped: 4,
			windowBoundary: "900",
			walkCursor: "800",
			parentId: "channel-1",
			windowSynced: 120,
		});
		// A walk upsert that only carries counts/phase (no identity fields).
		r.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "thread-1",
			phase: "complete",
			messagesSynced: 200,
			messagesSkipped: 6,
			windowBoundary: "900",
			walkCursor: "700",
		});

		const row = r.getBackfillProgress(SPACE_A, "thread-1");
		expect(row?.phase).toBe("complete");
		expect(row?.messagesSynced).toBe(200);
		expect(row?.parentId).toBe("channel-1");
		expect(row?.windowSynced).toBe(120);
	});

	test("a write without windowSynced preserves the phase-2 snapshot", () => {
		const r = repo();
		r.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "c1",
			phase: "phase2",
			messagesSynced: 50,
			messagesSkipped: 0,
			windowBoundary: "900",
			walkCursor: "800",
			windowSynced: 50,
		});
		// The walk's mid-walk upserts carry no windowSynced (absolute-count
		// writes only) — they must not erase the phase-1 snapshot.
		r.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "c1",
			phase: "phase2",
			messagesSynced: 90,
			messagesSkipped: 1,
			windowBoundary: "900",
			walkCursor: "750",
		});
		expect(r.getBackfillProgress(SPACE_A, "c1")?.windowSynced).toBe(50);
	});
});
