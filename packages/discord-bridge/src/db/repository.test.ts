import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
    expect(result.applied).toEqual([1, 2]);
    expect(result.current).toBe(2);
  });

  test("are idempotent across re-runs", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe(2);
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
    expect(list.map((c) => c.spaceDid).sort()).toEqual([SPACE_A, SPACE_B].sort());
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
    expect(r.getTargetSpacesForChannel(GUILD, "any-channel")).toEqual([SPACE_A]);
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
});
