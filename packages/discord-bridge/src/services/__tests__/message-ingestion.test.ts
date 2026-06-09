/**
 * Unit tests for message-ingestion.ts
 *
 * Covers: MI01–MI16 — basic sync, fan-out, dedup, system messages,
 * thread starters, mentions, attachments, backfill restriction, subset mode.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import { ingestDiscordMessage } from "../message-ingestion.ts";
import { createMockSpaceManager } from "./helpers/mock-space-manager.ts";
import {
  SPACE_A,
  SPACE_B,
  GUILD,
  CHANNEL,
  ROOMY_CHANNEL_ULID,
  ROOMY_MESSAGE_ULID,
  ROOMY_MESSAGE_ULID_2,
  USER_ID,
  SNOWFLAKE_CHANNEL,
  SNOWFLAKE_USER,
  makeMessage,
  makeAttachment,
  makeReplyMessage,
  makeThreadStarterMessage,
  MESSAGE_WITH_IMAGE,
  MESSAGE_WITH_VIDEO,
  MESSAGE_WITH_FILE,
} from "./helpers/test-data.ts";

/** Extract the createMessage event from a space (skip profile sync events). */
function createMessageEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    const event = call[0];
    if (event.$type === "space.roomy.message.createMessage.v0") return event;
  }
  return undefined;
}

/** Extract the forwardMessages event. */
function forwardMessageEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    const event = call[0];
    if (event.$type === "space.roomy.message.forwardMessages.v0") return event;
  }
  return undefined;
}

/** Decode the body data from a createMessage event. */
function decodeBody(event: any): string {
  const bytes: { $bytes: string } = event.body.data;
  return atob(bytes.$bytes);
}

/** Convenience: create a fresh repository with a pre-configured bridge. */
function setupRepo(
  mode: "full" | "subset" = "full",
  spaceDid: string = SPACE_A,
): BridgeRepository {
  const repo = BridgeRepository.open(":memory:");
  repo.upsertBridgeConfig(GUILD, spaceDid, mode);
  return repo;
}

/** Set up channel mapping so ingest can find its Roomy room. */
function mapChannel(
  repo: BridgeRepository,
  channelId: string = CHANNEL,
  roomyUlid: string = ROOMY_CHANNEL_ULID,
  spaceDid: string = SPACE_A,
) {
  repo.registerMapping(spaceDid, "channel", channelId, roomyUlid);
}

function mapMessage(
  repo: BridgeRepository,
  discordId: string,
  roomyId: string = ROOMY_MESSAGE_ULID,
  spaceDid: string = SPACE_A,
) {
  repo.registerMapping(spaceDid, "message", discordId, roomyId);
}

function mapThread(
  repo: BridgeRepository,
  threadId: string,
  roomyId: string = ROOMY_MESSAGE_ULID_2,
  spaceDid: string = SPACE_A,
) {
  repo.registerMapping(spaceDid, "thread", threadId, roomyId);
}

const SNOWFLAKE_MSG = BigInt("987654321");

describe("ingestDiscordMessage — basic sync", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // MI01: Basic message sync to one target space
  test("MI01: syncs a basic message to one space", async () => {
    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 1, skipped: 0 });

    const event = createMessageEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.message.createMessage.v0");
    expect(
      event.extensions["space.roomy.extension.discordMessageOrigin.v0"]
        .snowflake,
    ).toBe(SNOWFLAKE_MSG.toString());
    expect(
      event.extensions["space.roomy.extension.authorOverride.v0"].did,
    ).toBe(`did:discord:${USER_ID}`);

    // Mapping registered
    expect(
      repo.getRoomyId(SPACE_A, "message", SNOWFLAKE_MSG.toString()),
    ).toBe(event.id);

    // Cursor advanced
    expect(repo.getChannelCursor(SPACE_A, CHANNEL)?.lastMessageId).toBe(
      SNOWFLAKE_MSG.toString(),
    );
  });

  // MI02: Fan-out to multiple spaces
  test("MI02: fans out message to multiple bridged spaces", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);

    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 2, skipped: 0 });
    expect(
      createMessageEvent(manager, SPACE_A),
    ).toBeDefined();
    expect(
      createMessageEvent(manager, SPACE_B),
    ).toBeDefined();
  });

  // MI03: Dedup — duplicate skipped
  test("MI03: skips duplicate message (already has mapping)", async () => {
    mapMessage(repo, SNOWFLAKE_MSG.toString());
    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    // No createMessage event should be sent (profile sync may still call sendEvent)
    expect(
      createMessageEvent(manager, SPACE_A),
    ).toBeUndefined();
  });

  // MI04: No target space for channel
  test("MI04: skips when channel not bridged to any space", async () => {
    const unbridgedRepo = BridgeRepository.open(":memory:");
    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      unbridgedRepo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });

  // MI05: Missing Roomy room mapping (uses unmapped channel)
  test("MI05: skips if channel has no Roomy room mapping", async () => {
    const unmappedChannel = "999999999999999999";
    const msg = makeMessage({ id: SNOWFLAKE_MSG, channelId: BigInt(unmappedChannel) });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    // SPACE_A is full mode, so the channel appears in targetSpaces,
    // but no room mapping exists => skip without error
    expect(createMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  // MI06: System messages skipped
  test("MI06: skips system messages (ThreadCreated, ChannelNameChange)", async () => {
    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      type: 18, // ThreadCreated
    });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );
    expect(result).toEqual({ synced: 0, skipped: 1 });
    // Only profile sync event, no createMessage
    expect(
      createMessageEvent(manager, SPACE_A),
    ).toBeUndefined();
  });

  // MI07: Message with no content and no attachments skipped
  test("MI07: skips message with no content and no attachments", async () => {
    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "",
      attachments: [],
    });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );
    expect(result).toEqual({ synced: 0, skipped: 1 });
    // Profile sync sends an event, but no createMessage
    expect(
      createMessageEvent(manager, SPACE_A),
    ).toBeUndefined();
  });
});

describe("ingestDiscordMessage — profile sync & cursor", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // MI09: Cursor advancement
  test("MI09: advances cursor after successful sync", async () => {
    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const cursor = repo.getChannelCursor(SPACE_A, CHANNEL);
    expect(cursor?.lastMessageId).toBe(SNOWFLAKE_MSG.toString());
  });

  // MI10: Cursor NOT updated on send failure
  test("MI10: does not update cursor when sendEvent fails for message", async () => {
    // Mock space so the first call (profile sync) succeeds but the second (message) fails.
    const space = manager.space(SPACE_A);
    space.sendEvent
      .mockResolvedValueOnce(undefined)   // profile sync succeeds
      .mockRejectedValueOnce(new Error("Failed")); // message fails

    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    const cursor = repo.getChannelCursor(SPACE_A, CHANNEL);
    expect(cursor).toBeUndefined();
  });
});

describe("ingestDiscordMessage — attachments", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // MI11: Attachments — image, video, file, reply
  test("MI11a: syncs message with image attachment", async () => {
    const msg = MESSAGE_WITH_IMAGE;
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    expect(attExt).toBeDefined();
    const attachments = attExt.attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].$type).toBe("space.roomy.attachment.image.v0");
    expect(attachments[0].mimeType).toBe("image/png");
  });

  test("MI11b: syncs message with video attachment", async () => {
    const msg = MESSAGE_WITH_VIDEO;
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    expect(attExt).toBeDefined();
    const attachments = attExt.attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].$type).toBe("space.roomy.attachment.video.v0");
  });

  test("MI11c: syncs message with generic file attachment", async () => {
    const msg = MESSAGE_WITH_FILE;
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    expect(attExt).toBeDefined();
    const attachments = attExt.attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].$type).toBe("space.roomy.attachment.file.v0");
    expect(attachments[0].name).toBe("doc.pdf");
  });

  test("MI11d: syncs reply attachment", async () => {
    const replyTarget = BigInt("5555555555");
    mapMessage(repo, replyTarget.toString(), ROOMY_MESSAGE_ULID);

    const msg = makeReplyMessage(replyTarget);
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    expect(attExt).toBeDefined();
    const attachments = attExt.attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].$type).toBe("space.roomy.attachment.reply.v0");
    expect(attachments[0].target).toBe(ROOMY_MESSAGE_ULID);
  });

  test("MI11e: skips reply when target message not synced", async () => {
    const replyTarget = BigInt("5555555555");
    // Do NOT map the reply target
    const msg = makeReplyMessage(replyTarget);
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    // Reply attachment should be absent (no mapping), but message itself still syncs
    // No reply target means attachments array is empty, so no extension added
    expect(attExt).toBeUndefined();
  });
});

describe("ingestDiscordMessage — stickers", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // EC01: Message with only stickers
  test("EC01: syncs message with sticker items (no text/attachments)", async () => {
    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "",
      stickerItems: [
        { id: BigInt("1001"), formatType: 2 }, // PNG sticker
        { id: BigInt("1002"), formatType: 4 }, // GIF sticker
      ],
    });

    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 1, skipped: 0 });

    const event = createMessageEvent(manager, SPACE_A);
    const attExt = event.extensions["space.roomy.extension.attachments.v0"];
    expect(attExt).toBeDefined();
    const attachments = attExt.attachments;
    expect(attachments).toHaveLength(2);
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[1].mimeType).toBe("image/gif");
  });

  // EC02: Message with empty content + embed (no attachments) skipped
  test("EC02: skips empty content without attachments (no sticker)", async () => {
    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      content: "",
      attachments: [],
      stickerItems: [],
    });

    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    // Profile sync may fire but createMessage should not
    expect(createMessageEvent(manager, SPACE_A)).toBeUndefined();
  });
});

describe("ingestDiscordMessage — mention resolution", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // MI14: Mention resolution
  test("MI14a: resolves user and channel mentions", async () => {
    mapMessage(repo, SNOWFLAKE_MSG.toString()); // pre-sync for dedup test

    const msg = makeMessage({
      id: BigInt("1111111118"),
      content: "Hey <@111111111111111111>, check <#123456789012345678>",
      mentions: [{
        id: SNOWFLAKE_USER,
        username: "testuser",
        globalName: "Test User",
        discriminator: "1234",
      }],
      mentionedChannelIds: [SNOWFLAKE_CHANNEL],
    });

    const resolveChannelName = async (snowflake: string) => {
      return snowflake === CHANNEL ? "general" : undefined;
    };

    await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
      undefined,
      undefined,
      resolveChannelName,
    );

    const event = createMessageEvent(manager, SPACE_A);
    const decoded = decodeBody(event);
    expect(decoded).toContain("[@Test User]()");
    expect(decoded).toContain("[#general](" + ROOMY_CHANNEL_ULID + ")");
  });

  test("MI14b: strips custom emoji from content", async () => {
    const msg = makeMessage({
      id: BigInt("1111111119"),
      content: "This is <:blob:999999999999999999> amazing!",
    });

    await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    const event = createMessageEvent(manager, SPACE_A);
    const decoded = decodeBody(event);
    expect(decoded).toBe("This is  amazing!");
  });
});

describe("ingestDiscordMessage — threadStarterMessage", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // MI12: ThreadStarterMessage forwards original message to thread room
  test("MI12a: forwards original message when both thread and original are mapped", async () => {
    const originalId = BigInt("3333333333");
    const threadId = "423456789012345678";
    const parentChannelId = CHANNEL;

    // Set up mappings: parent channel, thread room, and original message
    mapChannel(repo, parentChannelId, ROOMY_CHANNEL_ULID);
    mapThread(repo, threadId, ROOMY_MESSAGE_ULID_2);
    mapMessage(repo, originalId.toString(), ROOMY_MESSAGE_ULID);

    const msg = makeThreadStarterMessage(
      originalId,
      BigInt(threadId),
      BigInt(parentChannelId),
    );
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 1, skipped: 0 });

    const event = forwardMessageEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.message.forwardMessages.v0");
    expect(event.room).toBe(ROOMY_MESSAGE_ULID_2);
    expect(event.messageIds).toEqual([ROOMY_MESSAGE_ULID]);
    expect(event.fromRoomId).toBe(ROOMY_CHANNEL_ULID);
  });

  // MI13: ThreadStarterMessage skips if original not synced
  test("MI13a: skips forwarding when original message not synced", async () => {
    const originalId = BigInt("3333333333");
    const threadId = "423456789012345678";
    const parentChannelId = CHANNEL;

    mapChannel(repo, parentChannelId, ROOMY_CHANNEL_ULID);
    mapThread(repo, threadId, ROOMY_MESSAGE_ULID_2);
    // Do NOT map originalId

    const msg = makeThreadStarterMessage(
      originalId,
      BigInt(threadId),
      BigInt(parentChannelId),
    );
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    expect(forwardMessageEvent(manager, SPACE_A)).toBeUndefined();
    expect(createMessageEvent(manager, SPACE_A)).toBeUndefined();
  });

  test("MI13b: skips forwarding when thread room not mapped", async () => {
    const originalId = BigInt("3333333333");
    const threadId = "423456789012345678";

    mapMessage(repo, originalId.toString(), ROOMY_MESSAGE_ULID);

    const msg = makeThreadStarterMessage(originalId, BigInt(threadId));
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 0, skipped: 1 });
    expect(forwardMessageEvent(manager, SPACE_A)).toBeUndefined();
  });
});

describe("ingestDiscordMessage — backfill path & subset mode", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    mapChannel(repo);
  });

  // MI15: Backfill path (spaceDidOverride) restricts to single space
  test("MI15: spaceDidOverride restricts sync to one space", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);

    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
      undefined,
      SPACE_A, // only target SPACE_A
    );

    expect(result).toEqual({ synced: 1, skipped: 0 });
    expect(createMessageEvent(manager, SPACE_A)).toBeDefined();
    expect(createMessageEvent(manager, SPACE_B)).toBeUndefined();
  });

  // MI16: Multiple spaces with subset mode
  test("MI16: subset mode only targets allowlisted channels", async () => {
    // SPACE_A is full (already set up), SPACE_B is subset
    repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");
    // Allowlist channel in SPACE_B
    repo.addToAllowlist(SPACE_B, CHANNEL, GUILD);
    mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);

    const msg = makeMessage({ id: SNOWFLAKE_MSG, channelId: SNOWFLAKE_CHANNEL });
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    // Both spaces should get the message
    expect(result).toEqual({ synced: 2, skipped: 0 });
    expect(createMessageEvent(manager, SPACE_A)).toBeDefined();
    expect(createMessageEvent(manager, SPACE_B)).toBeDefined();
  });

  test("MI16b: subset mode skips non-allowlisted channels", async () => {
    // Also map the otherChannel in SPACE_A (which is full mode) so it's not
    // blocked by a missing room mapping — bring in a non-allowlisted channel
    // for SPACE_B to exercise subset rejection.
    const otherChannel = "999999999999999999";
    repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");
    mapChannel(repo, otherChannel, ROOMY_CHANNEL_ULID); // SPACE_A full mode
    repo.registerMapping(SPACE_B, "channel", otherChannel, ROOMY_CHANNEL_ULID);
    // Do NOT add otherChannel to SPACE_B's allowlist

    const msg = makeMessage({
      id: SNOWFLAKE_MSG,
      channelId: BigInt(otherChannel),
    });

    // SPACE_A (full) should get it; SPACE_B (subset, not allowlisted) should not
    const result = await ingestDiscordMessage(
      msg as any,
      repo,
      manager._manager,
    );

    expect(result).toEqual({ synced: 1, skipped: 0 });
    expect(createMessageEvent(manager, SPACE_A)).toBeDefined();
    expect(createMessageEvent(manager, SPACE_B)).toBeUndefined();
  });

  // MI08: Profile sync is triggered alongside message (integration check)
  test("MI08: message sync calls getOrConnect for each space", async () => {
    const msg = makeMessage({ id: SNOWFLAKE_MSG });
    await ingestDiscordMessage(msg as any, repo, manager._manager);

    // getOrConnect should have been called (for profile sync + event send)
    expect(manager._manager.getOrConnect).toHaveBeenCalled();
  });

  // EC04: Very long message content
  test("EC04: handles very long message content", async () => {
    const longContent = "x".repeat(3000);
    const msg = makeMessage({ id: SNOWFLAKE_MSG, content: longContent });

    await ingestDiscordMessage(msg as any, repo, manager._manager);

    const event = createMessageEvent(manager, SPACE_A);
    const decoded = decodeBody(event);
    expect(decoded).toBe(longContent);
  });
});