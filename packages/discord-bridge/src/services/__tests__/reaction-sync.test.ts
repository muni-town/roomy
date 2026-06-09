/**
 * Unit tests for reaction-sync.ts
 *
 * Covers: RS01–RS09 — reaction add/remove with/without mapping,
 * idempotency, custom emoji parsing, fan-out, subset mode.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import { handleReactionAdd, handleReactionRemove } from "../reaction-sync.ts";
import { createMockSpaceManager } from "./helpers/mock-space-manager.ts";
import { reactionKey } from "../../utils/emoji.ts";
import {
  SPACE_A,
  SPACE_B,
  GUILD,
  CHANNEL,
  ROOMY_CHANNEL_ULID,
  ROOMY_MESSAGE_ULID,
  SNOWFLAKE_CHANNEL,
  SNOWFLAKE_USER,
  SNOWFLAKE_USER_2,
} from "./helpers/test-data.ts";

/** Extract a reaction add event. */
function reactionAddEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    if (call[0].$type === "space.roomy.reaction.addBridgedReaction.v0") return call[0];
  }
  return undefined;
}

/** Extract a reaction remove event. */
function reactionRemoveEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    if (call[0].$type === "space.roomy.reaction.removeBridgedReaction.v0") return call[0];
  }
  return undefined;
}

function setupRepo(): BridgeRepository {
  const repo = BridgeRepository.open(":memory:");
  repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
  repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
  repo.registerMapping(SPACE_A, "message", "5555555555", ROOMY_MESSAGE_ULID);
  return repo;
}

const MESSAGE_ID = BigInt("5555555555");
const CHANNEL_ID = SNOWFLAKE_CHANNEL;
const USER_ID = SNOWFLAKE_USER;
const GUILD_ID = BigInt(GUILD);
const THUMBS_UP = { name: "👍" };

describe("handleReactionAdd", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // RS01: Reaction add to synced message
  test("RS01: sends addBridgedReaction for synced message", async () => {
    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    const event = reactionAddEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.reaction.addBridgedReaction.v0");
    expect(event.reactionTo).toBe(ROOMY_MESSAGE_ULID);
    expect(event.reaction).toBe("👍");
    expect(event.reactingUser).toBe(`did:discord:${USER_ID.toString()}`);
  });

  // RS02: Reaction add to unsynced message skipped
  test("RS02: skips reaction add when message not synced", async () => {
    await handleReactionAdd(
      BigInt("9999999999"), CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    expect(reactionAddEvent(manager, SPACE_A)).toBeUndefined();
  });

  // RS03: Reaction add duplicate (idempotent)
  test("RS03: skips duplicate reaction add when mapping exists", async () => {
    const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
    repo.registerMapping(SPACE_A, "reaction", key, "existing-event-ulid");

    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    expect(reactionAddEvent(manager, SPACE_A)).toBeUndefined();
  });

  // RS07: Reaction to channel not in allowlist (subset mode)
  test("RS07: skips reaction for channel not in subset allowlist", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");
    // Don't add CHANNEL to allowlist

    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    // SPACE_A (full) should get it, SPACE_B (subset without allowlist) should not
    expect(reactionAddEvent(manager, SPACE_A)).toBeDefined();
    expect(reactionAddEvent(manager, SPACE_B)).toBeUndefined();
  });

  // RS08: Reaction fan-out to multiple spaces
  test("RS08: fans out reaction to multiple bridged spaces", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
    repo.registerMapping(SPACE_B, "message", "5555555555", ROOMY_MESSAGE_ULID);

    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    expect(reactionAddEvent(manager, SPACE_A)).toBeDefined();
    expect(reactionAddEvent(manager, SPACE_B)).toBeDefined();
  });

  // RS09: Unicode vs custom emoji correctly parsed
  test("RS09a: handles unicode emoji", async () => {
    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    const event = reactionAddEvent(manager, SPACE_A);
    expect(event.reaction).toBe("👍");
  });

  test("RS09b: handles custom static emoji", async () => {
    const emoji = { id: BigInt("123456789"), name: "blob" };

    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, emoji, GUILD_ID,
      repo, manager._manager,
    );

    const event = reactionAddEvent(manager, SPACE_A);
    expect(event.reaction).toBe("<:blob:123456789>");
  });

  test("RS09c: handles animated custom emoji", async () => {
    const emoji = { id: BigInt("987654321"), name: "party", animated: true };

    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, emoji, GUILD_ID,
      repo, manager._manager,
    );

    const event = reactionAddEvent(manager, SPACE_A);
    expect(event.reaction).toBe("<a:party:987654321>");
  });
});

describe("handleReactionRemove", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // RS04: Reaction remove with mapping
  test("RS04: sends removeBridgedReaction and unregisters mapping", async () => {
    const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
    repo.registerMapping(SPACE_A, "reaction", key, "existing-event-ulid");

    await handleReactionRemove(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    const event = reactionRemoveEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.reaction.removeBridgedReaction.v0");
    expect(event.reactionId).toBe("existing-event-ulid");

    // Mapping removed
    expect(repo.getRoomyId(SPACE_A, "reaction", key)).toBeUndefined();
  });

  // RS05: Reaction remove without mapping skipped
  test("RS05: skips remove when no reaction mapping exists", async () => {
    await handleReactionRemove(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    expect(reactionRemoveEvent(manager, SPACE_A)).toBeUndefined();
  });

  // RS06: Reaction remove then re-add
  test("RS06: re-add after remove creates fresh mapping", async () => {
    const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
    // Add once
    repo.registerMapping(SPACE_A, "reaction", key, "old-event-ulid");

    // Remove
    await handleReactionRemove(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    // Mapping should be gone
    expect(repo.getRoomyId(SPACE_A, "reaction", key)).toBeUndefined();

    // Re-add — should succeed without "already exists" dedup
    await handleReactionAdd(
      MESSAGE_ID, CHANNEL_ID, USER_ID, THUMBS_UP, GUILD_ID,
      repo, manager._manager,
    );

    const addEvent = reactionAddEvent(manager, SPACE_A);
    expect(addEvent).toBeDefined();
    expect(addEvent.id).not.toBe("old-event-ulid");

    // Fresh mapping
    const newMapping = repo.getRoomyId(SPACE_A, "reaction", key);
    expect(newMapping).toBeDefined();
    expect(newMapping).toBe(addEvent.id);
  });
});