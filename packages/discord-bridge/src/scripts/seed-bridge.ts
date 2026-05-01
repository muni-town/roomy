/**
 * Seed script for bootstrapping bridge config into SQLite.
 *
 * Usage:
 *   bun run src/scripts/seed-bridge.ts \
 *     --guild <discord_guild_id> \
 *     --space <roomy_space_did> \
 *     --channel <discord_channel_id> \
 *     --mode full|subset \
 *     --name "Channel Name"
 *
 * For subset mode, --channel can be repeated:
 *   --channel 123 --channel 456
 *
 * Requires env vars: ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD,
 * LEAF_URL, LEAF_SERVER_DID (or their defaults from .env).
 *
 * This script:
 * 1. Connects to the target Roomy space via Leaf
 * 2. Creates a Roomy channel room for each --channel
 * 3. Inserts bridge_config row (guild + space + mode)
 * 4. Inserts id_mappings for each channel (room:<discordId> → roomyRoomUlid)
 * 5. If subset mode, inserts allowlist rows for each channel
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { BridgeRepository } from "../db/repository.ts";
import { initRoomyClient } from "../roomy/client.ts";
import { SpaceManager } from "../roomy/space-manager.ts";
import { newUlid, type Ulid } from "@roomy-space/sdk";

const { values } = parseArgs({
  options: {
    guild: { type: "string" },
    space: { type: "string" },
    channel: { type: "string", multiple: true },
    mode: { type: "string", default: "full" },
    name: { type: "string", multiple: true },
    "data-dir": { type: "string", default: "./data" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage: bun run src/scripts/seed-bridge.ts [options]

Options:
  --guild <id>         Discord guild ID (required)
  --space <did>        Roomy space DID (required)
  --channel <id>       Discord channel ID(s) (required, repeatable)
  --mode <mode>        Bridge mode: "full" or "subset" (default: full)
  --name <name>        Channel name(s) for Roomy rooms (optional, pairs with --channel)
  --data-dir <dir>     Bridge data directory (default: ./data)
  --help               Show this help
`);
  process.exit(0);
}

const guildId = values.guild ?? process.env.TEST_GUILD_ID;
const spaceDid = values.space ?? process.env.TEST_SPACE_DID;
const envChannels = process.env.TEST_CHANNEL_ID ? [process.env.TEST_CHANNEL_ID] : [];
const channels = (values.channel ?? envChannels).length > 0 ? (values.channel ?? envChannels) : [];
const mode = values.mode as "full" | "subset";
const names = values.name ?? [];
const dataDir = values["data-dir"];

if (!guildId || !spaceDid || channels.length === 0) {
  console.error("Error: --guild, --space, and at least one --channel are required.");
  console.error("  Provide via CLI flags or TEST_GUILD_ID, TEST_SPACE_DID, TEST_CHANNEL_ID env vars.");
  process.exit(1);
}

if (mode !== "full" && mode !== "subset") {
  console.error('Error: --mode must be "full" or "subset".');
  process.exit(1);
}

async function seed() {
  // Open SQLite
  const dbPath = join(dataDir!, "bridge.sqlite");
  const repo = BridgeRepository.open(dbPath);
  console.log(`Opened database at ${dbPath}`);

  // Insert bridge_config
  repo.upsertBridgeConfig(guildId!, spaceDid!, mode);
  console.log(`Created bridge_config: guild=${guildId} space=${spaceDid} mode=${mode}`);

  // Connect to Roomy space
  console.log("Connecting to Roomy...");
  const roomyClient = await initRoomyClient();
  const spaceManager = new SpaceManager(roomyClient);
  const connected = await spaceManager.getOrConnect(spaceDid!);
  console.log(`Connected to space ${spaceDid}`);

  // For each channel, create a Roomy room and register the mapping
  for (let i = 0; i < channels.length; i++) {
    const channelId = channels[i]!;
    const channelName = names[i] ?? (channels.length === 1 ? "general" : `discord-${channelId}`);

    const roomUlid = newUlid();

    const createRoomEvent = {
      id: roomUlid,
      $type: "space.roomy.room.createRoom.v0" as const,
      kind: "space.roomy.channel" as const,
      name: channelName,
      defaultAccess: "read" as const,
      extensions: {
        "space.roomy.extension.discordOrigin.v0": {
          $type: "space.roomy.extension.discordOrigin.v0",
          snowflake: channelId,
          guildId: guildId!,
        },
      },
    };

    await connected.sendEvent(createRoomEvent);
    console.log(`Created Roomy room ${roomUlid} "${channelName}" for Discord channel ${channelId}`);

    const roomKey = `room:${channelId}`;
    repo.registerMapping(spaceDid!, "channel", roomKey, roomUlid);
    console.log(`Registered mapping: ${roomKey} → ${roomUlid}`);

    if (mode === "subset") {
      repo.addToAllowlist(spaceDid!, channelId, guildId!);
      console.log(`Added channel ${channelId} to allowlist`);
    }
  }

  // Summary
  console.log("\n--- Seed Summary ---");
  console.log(`Guild:      ${guildId}`);
  console.log(`Space:      ${spaceDid}`);
  console.log(`Mode:       ${mode}`);
  console.log(`Channels:   ${channels.length}`);
  for (let i = 0; i < channels.length; i++) {
    const roomKey = `room:${channels[i]}`;
    const roomyId = repo.getRoomyId(spaceDid!, "channel", roomKey);
    const displayName = names[i] ?? (channels.length === 1 ? "general" : `discord-${channels[i]}`);
    console.log(`  ${channels[i]} → ${roomyId} (${displayName})`);
  }

  repo.close();
  await spaceManager.disconnectAll();
  console.log("\nDone. Bridge is ready to start.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
