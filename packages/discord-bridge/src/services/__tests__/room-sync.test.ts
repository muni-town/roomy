/**
 * Unit tests for room-sync.ts
 *
 * Covers: RO01–RO13 — channel/thread create, update, delete,
 * full/subset mode, public/private, fan-out, idempotency.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import {
  handleChannelCreate,
  handleThreadCreate,
  handleRoomUpdate,
  handleRoomDelete,
  ensureRoomyChannel,
} from "../room-sync.ts";
import { createMockSpaceManager } from "./helpers/mock-space-manager.ts";
import {
  SPACE_A,
  SPACE_B,
  GUILD,
  CHANNEL,
  CHANNEL_2,
  THREAD,
  ROOMY_CHANNEL_ULID,
  SNOWFLAKE_CHANNEL,
  SNOWFLAKE_THREAD,
  makeChannel,
  makeThread,
} from "./helpers/test-data.ts";

/** Extract a createRoom event from a space. */
function createRoomEvent(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
): any {
  const calls = manager.space(spaceDid).sendEvent.mock.calls;
  for (const call of calls) {
    if (call[0].$type === "space.roomy.room.createRoom.v0") return call[0];
  }
  return undefined;
}

/** Extract specific event types from sendEvents calls (used for threads). */
function eventsFromSendEvents(
  manager: ReturnType<typeof createMockSpaceManager>,
  spaceDid: string,
  $type: string,
): any[] {
  const result: any[] = [];
  const calls = manager.space(spaceDid).sendEvents.mock.calls;
  for (const call of calls) {
    const events: any[] = call[0];
    for (const evt of events) {
      if (evt.$type === $type) result.push(evt);
    }
  }
  return result;
}

function setupRepo(mode: "full" | "subset" = "full"): BridgeRepository {
  const repo = BridgeRepository.open(":memory:");
  repo.upsertBridgeConfig(GUILD, SPACE_A, mode);
  return repo;
}

describe("handleChannelCreate", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  // RO01: Channel create (full mode)
  test("RO01: creates room for new channel in full mode", async () => {
    const channel = makeChannel();

    await handleChannelCreate(channel, repo, manager._manager);

    const event = createRoomEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.room.createRoom.v0");
    expect(event.kind).toBe("space.roomy.channel");
    expect(event.name).toBe("general");
    expect(event.defaultAccess).toBe("read");

    // Mapping registered
    expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBe(event.id);

    // Discord origin extension
    const origin = event.extensions["space.roomy.extension.discordOrigin.v0"];
    expect(origin.snowflake).toBe(CHANNEL);
    expect(origin.guildId).toBe(GUILD);
  });

  // RO02: Channel create (subset mode, allowlisted)
  test("RO02: creates room for allowlisted channel in subset mode", async () => {
    repo = setupRepo("subset");
    repo.addToAllowlist(SPACE_A, CHANNEL, GUILD);
    manager = createMockSpaceManager();

    const channel = makeChannel();
    await handleChannelCreate(channel, repo, manager._manager);

    const event = createRoomEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.name).toBe("general");
  });

  // RO03: Channel create (subset mode, NOT allowlisted)
  test("RO03: skips channel not in subset allowlist", async () => {
    repo = setupRepo("subset");
    manager = createMockSpaceManager();

    const channel = makeChannel();
    await handleChannelCreate(channel, repo, manager._manager);

    expect(createRoomEvent(manager, SPACE_A)).toBeUndefined();
  });

  // RO04: Private channel → defaultAccess = "none"
  test("RO04: sets defaultAccess=none for private channel", async () => {
    // A private channel has a deny VIEW_CHANNEL override for @everyone
    const channel = makeChannel({
      permissionOverwrites: [
        { id: BigInt(GUILD), deny: ["VIEW_CHANNEL"] },
      ],
    });

    await handleChannelCreate(channel, repo, manager._manager);

    const event = createRoomEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.defaultAccess).toBe("none");
  });

  // RO05: Public channel → defaultAccess = "read"
  test("RO05: sets defaultAccess=read for public channel", async () => {
    const channel = makeChannel({
      permissionOverwrites: [
        { id: BigInt(GUILD), deny: [] },
      ],
    });

    await handleChannelCreate(channel, repo, manager._manager);

    const event = createRoomEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.defaultAccess).toBe("read");
  });

  // RO13: Channel create fan-out
  test("RO13: fans out channel creation to multiple spaces", async () => {
    repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
    manager = createMockSpaceManager();

    const channel = makeChannel();
    await handleChannelCreate(channel, repo, manager._manager);

    expect(createRoomEvent(manager, SPACE_A)).toBeDefined();
    expect(createRoomEvent(manager, SPACE_B)).toBeDefined();
  });

  test("skips when channel has no guildId", async () => {
    const channel = makeChannel({ guildId: undefined });
    await handleChannelCreate(channel, repo, manager._manager);
    expect(createRoomEvent(manager, SPACE_A)).toBeUndefined();
  });

  test("skips thread types dispatched as CHANNEL_CREATE", async () => {
    const channel = makeChannel({ type: 11 }); // PublicThread
    await handleChannelCreate(channel, repo, manager._manager);
    expect(createRoomEvent(manager, SPACE_A)).toBeUndefined();
  });

  test("skips when channel has no name", async () => {
    const channel = makeChannel({ name: undefined });
    await handleChannelCreate(channel, repo, manager._manager);
    expect(createRoomEvent(manager, SPACE_A)).toBeUndefined();
  });
});

describe("handleThreadCreate", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    // Pre-map the parent channel
    repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
  });

  // RO06: Thread create with parent bridged
  test("RO06: creates room + room link for thread under bridged parent", async () => {
    const thread = makeThread({ parentId: SNOWFLAKE_CHANNEL });

    await handleThreadCreate(thread, repo, manager._manager);

    // Should use sendEvents with two events
    const roomEvents = eventsFromSendEvents(manager, SPACE_A, "space.roomy.room.createRoom.v0");
    const linkEvents = eventsFromSendEvents(manager, SPACE_A, "space.roomy.link.createRoomLink.v0");

    expect(roomEvents).toHaveLength(1);
    expect(roomEvents[0].kind).toBe("space.roomy.thread");
    expect(roomEvents[0].name).toBe("my-thread");

    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0].linkToRoom).toBe(roomEvents[0].id);
    expect(linkEvents[0].isCreationLink).toBe(true);

    // Mapping registered
    expect(repo.getRoomyId(SPACE_A, "thread", THREAD)).toBe(roomEvents[0].id);
  });

  // RO07: Thread create without parent bridged
  test("RO07: skips thread when parent channel not bridged", async () => {
    const thread = makeThread({
      parentId: BigInt("999999999999999999"), // not bridged
    });

    await handleThreadCreate(thread, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvents).not.toHaveBeenCalled();
  });

  // RO08: Private thread skipped
  test("RO08: skips private threads", async () => {
    const thread = makeThread({
      type: 12, // PRIVATE_THREAD
      parentId: SNOWFLAKE_CHANNEL,
    });

    await handleThreadCreate(thread, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvents).not.toHaveBeenCalled();
  });

  // RO09: Thread create with existing mapping (idempotent)
  test("RO09: skips thread creation when mapping already exists", async () => {
    repo.registerMapping(SPACE_A, "thread", THREAD, "existing-ulid");

    const thread = makeThread({ parentId: SNOWFLAKE_CHANNEL });
    await handleThreadCreate(thread, repo, manager._manager);

    expect(manager.space(SPACE_A).sendEvents).not.toHaveBeenCalled();
  });

  test("skips thread without parentId or guildId", async () => {
    const noParent = makeThread({ parentId: undefined });
    await handleThreadCreate(noParent, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvents).not.toHaveBeenCalled();

    const noGuild = makeThread({ guildId: undefined });
    await handleThreadCreate(noGuild, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvents).not.toHaveBeenCalled();
  });
});

describe("handleRoomUpdate", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
  });

  // RO10: Channel/thread update (rename)
  test("RO10: sends updateRoom for renamed channel", async () => {
    const channel = makeChannel({ name: "new-name" });

    await handleRoomUpdate(channel, repo, manager._manager);

    const event = manager.eventsFor(SPACE_A)[0];
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.room.updateRoom.v0");
    expect(event.roomId).toBe(ROOMY_CHANNEL_ULID);
    expect(event.name).toBe("new-name");
  });

  test("skips update for unmapped channel", async () => {
    const channel = makeChannel({ id: BigInt("999999999999999999") });
    await handleRoomUpdate(channel, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });

  test("skips update when channel has no name", async () => {
    const channel = makeChannel({ name: undefined });
    await handleRoomUpdate(channel, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });

  test("skips update when guildId missing", async () => {
    const channel = makeChannel({ guildId: undefined });
    await handleRoomUpdate(channel, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });
});

describe("handleRoomDelete", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
    repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
  });

  // RO11: Channel/thread delete
  test("RO11: sends deleteRoom and unregisters mapping", async () => {
    const channel = makeChannel();

    await handleRoomDelete(channel, repo, manager._manager);

    const event = manager.eventsFor(SPACE_A)[0];
    expect(event).toBeDefined();
    expect(event.$type).toBe("space.roomy.room.deleteRoom.v0");
    expect(event.roomId).toBe(ROOMY_CHANNEL_ULID);

    // Mapping removed
    expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBeUndefined();
  });

  // RO12: Delete on unmapped room skipped
  test("RO12: skips delete for unmapped channel", async () => {
    const channel = makeChannel({ id: BigInt("999999999999999999") });
    await handleRoomDelete(channel, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });

  test("skips delete when no guildId", async () => {
    const channel = makeChannel({ guildId: undefined });
    await handleRoomDelete(channel, repo, manager._manager);
    expect(manager.space(SPACE_A).sendEvent).not.toHaveBeenCalled();
  });
});

describe("ensureRoomyChannel", () => {
  let repo: BridgeRepository;
  let manager: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    repo = setupRepo();
    manager = createMockSpaceManager();
  });

  test("creates room for a channel in target spaces", async () => {
    await ensureRoomyChannel(
      repo, manager._manager, CHANNEL, GUILD, "general", [SPACE_A],
    );

    const event = createRoomEvent(manager, SPACE_A);
    expect(event).toBeDefined();
    expect(event.name).toBe("general");
    expect(event.defaultAccess).toBe("read");
    expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBe(event.id);
  });

  test("skips channel already synced to a space", async () => {
    repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);

    await ensureRoomyChannel(
      repo, manager._manager, CHANNEL, GUILD, "general", [SPACE_A],
    );

    expect(createRoomEvent(manager, SPACE_A)).toBeUndefined();
  });

  test("respects defaultAccess override", async () => {
    await ensureRoomyChannel(
      repo, manager._manager, CHANNEL, GUILD, "private-channel", [SPACE_A], "none",
    );

    const event = createRoomEvent(manager, SPACE_A);
    expect(event.defaultAccess).toBe("none");
  });
});