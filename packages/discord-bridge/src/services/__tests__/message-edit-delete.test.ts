/**
 * Unit tests for message-edit-delete.ts
 *
 * Covers: ED01–ED10 — edit/delete with and without mappings,
 * editedTimestamp gate, mention resolution, profile sync, fan-out.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import { handleMessageEdit, handleMessageDelete } from "../message-edit-delete.ts";
import { createMockSpaceManager } from "./helpers/mock-space-manager.ts";
import {
  SPACE_A,
  SPACE_B,
  GUILD,
  CHANNEL,
  ROOMY_CHANNEL_ULID,
  ROOMY_MESSAGE_ULID,
  SNOWFLAKE_CHANNEL,
  SNOWFLAKE_USER,
  makeMessage,
} from "./helpers/test-data.ts";

/** Extract the editMessage event from a space (skip profile sync events). */
function editMessageEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    const event = call[0];
    if (event.$type === "space.roomy.message.editMessage.v0") return event;
  }
  return undefined;
}

/** Extract the deleteMessage event from a space. */
function deleteMessageEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    const event = call[0];
    if (event.$type === "space.roomy.message.deleteMessage.v0") return event;
  }
  return undefined;
}

function setupRepo(): BridgeRepository {
  const repo = BridgeRepository.open(":memory:");
  repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
  repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
  return repo;
}

const SNOWFLAKE_MSG = BigInt("987654321");
const MSG_ID_STR = SNOWFLAKE_MSG.toString();

describe("handleMessageEdit", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // ED01: Edit with existing mapping
  test("ED01: sends editMessage when mapping exists", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Updated content",
      editedTimestamp: Date.now(),
    });

    await handleMessageEdit(msg as any, repo, manager._manager);

    const event = editMessageEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.message.editMessage.v0");
    expect(event.messageId).toBe(ROOMY_MESSAGE_ULID);
    // Decode body
    const data = event.body.data;
    const decoded = atob(data.$bytes);
    expect(decoded).toBe("Updated content");
  });

  // ED02: Edit without editedTimestamp skipped
  test("ED02: skips edit when editedTimestamp is absent", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Updated",
      editedTimestamp: null,
    });

    await handleMessageEdit(msg as any, repo, manager._manager);
    expect(editMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // ED03: Edit without mapping skipped
  test("ED03: skips edit when no Roomy message mapping exists", async () => {
    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Updated",
      editedTimestamp: Date.now(),
    });

    await handleMessageEdit(msg as any, repo, manager._manager);
    expect(editMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // ED04: Edit to unsynced channel skipped
  test("ED04: skips edit for channel without Roomy room mapping", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      channelId: BigInt("999999999999999999"), // no room mapping
      content: "Updated",
      editedTimestamp: Date.now(),
    });

    await handleMessageEdit(msg as any, repo, manager._manager);

    // No edit event due to missing room mapping
    expect(editMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // ED05: Edit with mention resolution
  test("ED05: resolves mentions in edited content", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Edited <@111111111111111111>!",
      editedTimestamp: Date.now(),
      mentions: [{
        id: SNOWFLAKE_USER,
        username: "testuser",
        globalName: "Test User",
        discriminator: "1234",
      }],
    });

    await handleMessageEdit(msg as any, repo, manager._manager);

    const event = editMessageEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    const decoded = atob(event.body.data.$bytes);
    expect(decoded).toContain("[@Test User]()");
  });

  // ED06: Edit triggers profile sync
  test("ED06: calls getOrConnect for profile sync alongside edit", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Edited",
      editedTimestamp: Date.now(),
    });

    await handleMessageEdit(msg as any, repo, manager._manager);
    // getOrConnect should have been called (for profile sync + send)
    expect(manager._manager.getOrConnect).toHaveBeenCalled();
  });

  // ED10: Edit fan-out to multiple spaces
  test("ED10: fans out edit to multiple bridged spaces", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
    repo.registerMapping(SPACE_B, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "Fan-out edit",
      editedTimestamp: Date.now(),
    });

    await handleMessageEdit(msg as any, repo, manager._manager);

    expect(editMessageEvent(manager, SPACE_A)).toBeDefined();
    expect(editMessageEvent(manager, SPACE_B)).toBeDefined();
  });
});

describe("handleMessageDelete", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // ED07: Delete with mapping
  test("ED07: sends deleteMessage when mapping exists (mapping preserved)", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    await handleMessageDelete(
      SNOWFLAKE_MSG,
      SNOWFLAKE_CHANNEL,
      BigInt(GUILD),
      repo,
      manager._manager,
    );

    const event = deleteMessageEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.message.deleteMessage.v0");
    expect(event.messageId).toBe(ROOMY_MESSAGE_ULID);

    // Mapping preserved (not deleted)
    expect(repo.getRoomyId(SPACE_A, "message", MSG_ID_STR)).toBe(ROOMY_MESSAGE_ULID);
  });

  // ED08: Delete without mapping skipped
  test("ED08: skips delete when no mapping exists", async () => {
    await handleMessageDelete(
      SNOWFLAKE_MSG,
      SNOWFLAKE_CHANNEL,
      BigInt(GUILD),
      repo,
      manager._manager,
    );

    expect(deleteMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // ED09: Delete from unsynced channel skipped
  test("ED09: skips delete for channel without room mapping", async () => {
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    await handleMessageDelete(
      SNOWFLAKE_MSG,
      BigInt("999999999999999999"),
      BigInt(GUILD),
      repo,
      manager._manager,
    );

    // No delete event because room mapping is checked
    expect(deleteMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // ED10: Delete fan-out to multiple spaces
  test("ED10: fans out delete to multiple bridged spaces", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
    repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
    repo.registerMapping(SPACE_B, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

    await handleMessageDelete(
      SNOWFLAKE_MSG,
      SNOWFLAKE_CHANNEL,
      BigInt(GUILD),
      repo,
      manager._manager,
    );

    expect(deleteMessageEvent(manager, SPACE_A)).toBeDefined();
    expect(deleteMessageEvent(manager, SPACE_B)).toBeDefined();
  });

  test("exits early when guildId is undefined", async () => {
    await handleMessageDelete(
      SNOWFLAKE_MSG,
      SNOWFLAKE_CHANNEL,
      undefined,
      repo,
      manager._manager,
    );

    expect(deleteMessageEvent(manager, SPACE_A)).toBeUndefined();
  });
});