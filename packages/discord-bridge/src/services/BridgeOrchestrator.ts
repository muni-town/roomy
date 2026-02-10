import { RoomyClient, stateMachine, StateMachine, StreamDid } from "@roomy/sdk";
import { desiredProperties, DiscordBot } from "../discord/types.js";
import { initRoomyClient } from "../roomy/client";
import {
  createBot,
  Intents,
  InteractionTypes,
  MessageFlags,
} from "@discordeno/bot";
import { DISCORD_TOKEN } from "../env";
import { tracer, setDiscordAttrs, recordError } from "../tracing.js";
import {
  handleSlashCommandInteraction,
  safeDefer,
  slashCommands,
} from "../discord/slashCommands";
import { Deferred } from "@roomy/sdk";
import { registeredBridges } from "../repositories/LevelDBBridgeRepository";
import { Bridge } from "./Bridge";

type BridgeOrchestratorState =
  | {
      state: "initialising";
    }
  | {
      state: "ready";
      roomy: RoomyClient;
      bot: DiscordBot;
      appId: string;
    };

/** Bridge Singleton Sync Router
 * The goal for this singleton is to manage initialisation up to the point that it holds
 * the minimum required 'global' state for delegating incoming events to handlers.
 *
 * Three-phase connection backfill process:
 * 1. Backfill connected Roomy spaces to populate sync maps
 * 2. Backfill connected Discord guilds and sync to Roomy
 * 3. Sync required Roomy data to Discord
 *
 * Once a Bridge is backfilled, then it can subscribe to incoming events from Discord and Roomy.
 */
export class BridgeOrchestrator {
  state: StateMachine<BridgeOrchestratorState> = stateMachine({
    state: "initialising",
  });
  bridges = new Map<bigint, Bridge>();

  constructor() {
    this.start();
  }

  get appId() {
    if (this.state.current.state !== "ready")
      throw new Error("Bridge not ready");
    return this.state.current.appId;
  }

  async start() {
    let roomy: Awaited<RoomyClient>;
    try {
      roomy = await initRoomyClient();
    } catch (e) {
      if ((e as Error).message?.includes("Stream does not exist")) {
        console.error(
          "\nThe personal stream record exists on PDS but the stream doesn't exist on the Leaf server.\n" +
            "This may happen after a Leaf server reset or data migration.\n" +
            "To fix, you may need to manually delete the stale PDS record:\n" +
            "  1. Find the record at: space.roomy.space.personal (rkey = schema version)\n" +
            "  2. Delete it via your PDS or ATPROTO tools\n" +
            "  3. Restart the bridge to create a new stream\n",
        );
      }
      throw e;
    }

    console.log("Connecting to Discord...");

    const { bot, appId } = await this.startBot();
    console.log("Discord bridge ready");

    console.log("Subscribing to connected spaces...");
    const bridges = await registeredBridges.list();

    console.log("bridges", bridges);

    for (const { spaceId, guildId } of bridges) {
      const bridge = await Bridge.connect({
        spaceId: spaceId as StreamDid,
        guildId: BigInt(guildId),
        bot,
        client: roomy,
      });
      this.bridges.set(BigInt(guildId), bridge);
    }
    this.state.current = {
      state: "ready",
      roomy,
      bot,
      appId,
    };
  }

  /**
   * A single instance of `bot` handles all events incoming from Discord across multiple guilds.
   * The event handlers route each event to Roomy spaces as defined in the persisted mapping.
   */
  async startBot() {
    const orchestrator = this;
    let appIdPromise = new Deferred<string>();
    const bot = createBot({
      token: DISCORD_TOKEN,
      intents:
        Intents.MessageContent |
        Intents.Guilds |
        Intents.GuildMessages |
        Intents.GuildMessageReactions,
      desiredProperties,
      events: {
        ready(ready) {
          console.log("Discord bot connected", ready);
          tracer.startActiveSpan("discord.bot.ready", (span) => {
            span.setAttribute(
              "discord.application.id",
              ready.applicationId.toString(),
            );
            span.setAttribute("discord.shard.id", ready.shardId);
            span.setAttribute("discord.guilds.count", ready.guilds.length);

            // Set Discord app ID used in `/info` API endpoint.
            appIdPromise.resolve(ready.applicationId.toString());

            // Update discord slash commands.
            bot.helpers.upsertGlobalApplicationCommands(slashCommands);

            span.end();
          });
        },

        // Handle slash commands
        async interactionCreate(interaction) {
          console.log("Interaction create event", interaction.data);
          const current = await orchestrator.state.transitionedTo("ready");

          const guildId = interaction.guildId;
          if (!guildId) {
            console.error("Guild ID missing from interaction:", interaction);
            interaction.respond({
              flags: MessageFlags.Ephemeral,
              content: "🛑 There was an error connecting your space. 😕",
            });
            return;
          }

          const bridge = orchestrator.bridges.get(guildId);

          const spaceExists = async (did: StreamDid) => {
            // Check if the bridge can access this space
            return !!(await current.roomy.getSpaceInfo(did))?.name;
          };

          return handleSlashCommandInteraction({
            interaction,
            guildId,
            spaceExists,
            createBridge: orchestrator.createBridge,
            bridge,
          });
        },

        async channelCreate(channel) {
          await orchestrator.withGuildBridge(
            "channelCreate",
            channel,
            { channelId: channel.id },
            (bridge, channel) => bridge.handleDiscordChannelCreate(channel),
          );
        },

        async threadCreate(channel) {
          await orchestrator.withGuildBridge(
            "threadCreate",
            channel,
            { channelId: channel.id },
            async (bridge, channel) => {
              if (!channel.parentId) {
                console.error(`Thread ${channel.name} has no parent channel`);
                return;
              }
              await bridge.handleDiscordThreadCreate(channel, channel.parentId);
            },
          );
        },

        // Handle new messages
        async messageCreate(message) {
          await orchestrator.withGuildBridge(
            "messageCreate",
            message,
            { messageId: message.id },
            async (bridge, message) => {
              await bridge.handleDiscordMessageCreate(message);
            },
          );
        },

        // Handle reaction add
        async reactionAdd(payload) {
          await orchestrator.withGuildBridge(
            "reactionAdd",
            payload,
            {
              messageId: payload.messageId,
              channelId: payload.channelId,
              userId: payload.userId,
            },
            (bridge, payload) =>
              bridge.handleDiscordReactionAdd(
                payload.messageId,
                payload.channelId,
                payload.userId,
                payload.emoji,
              ),
          );
        },

        // Handle reaction remove
        async reactionRemove(payload) {
          await orchestrator.withGuildBridge(
            "reactionRemove",
            payload,
            {
              messageId: payload.messageId,
              channelId: payload.channelId,
              userId: payload.userId,
            },
            (bridge, payload) =>
              bridge.handleDiscordReactionRemove(
                payload.messageId,
                payload.channelId,
                payload.userId,
                payload.emoji,
              ),
          );
        },

        // Handle message edits
        async messageUpdate(message) {
          await orchestrator.withGuildBridge(
            "messageUpdate",
            message,
            { messageId: message.id },
            (bridge, message) => bridge.handleDiscordMessageUpdate(message),
          );
        },
      },
    });
    bot.start();
    const appId = await appIdPromise.promise;
    return { bot, appId };
  }

  async createBridge(spaceId: StreamDid, guildId: bigint) {
    const current = await this.state.transitionedTo("ready");
    const bridge = await Bridge.connect({
      spaceId,
      bot: current.bot,
      guildId,
      client: current.roomy,
    });
    this.bridges.set(guildId, bridge);
    return bridge;
  }

  /**
   * Common handler wrapper with tracing and error handling.
   */
  private async withGuildBridge<T extends { guildId?: bigint }>(
    eventName: string,
    data: T,
    attrs: Record<string, bigint | string>,
    handler: (bridge: Bridge, data: T) => Promise<unknown>,
  ): Promise<void> {
    await this.state.transitionedTo("ready");
    if (!data.guildId) {
      console.warn(`Guild ID missing from ${eventName}`);
      return;
    }

    const bridge = this.bridges.get(data.guildId);
    if (!bridge) {
      console.warn(
        `No bridge found for guild ${data.guildId}, skipping ${eventName}`,
      );
      return;
    }

    await tracer.startActiveSpan(`bridge.${eventName}`, async (span) => {
      setDiscordAttrs(span, { guildId: data.guildId!, ...attrs });
      try {
        await handler(bridge, data);
      } catch (error) {
        recordError(span, error);
        // Don't throw - fail gracefully
      } finally {
        span.end();
      }
    });
  }

  /**
   * Get the bridge's DID.
   */
  getBridgeDid(): string {
    if (this.state.current.state !== "ready")
      throw new Error("Bridge not ready");
    return this.state.current.roomy.agent.assertDid;
  }
}
