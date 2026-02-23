import { RoomyClient, stateMachine, StateMachine, StreamDid } from "@roomy/sdk";
import {
  desiredProperties,
  DiscordBot,
  DiscordEvent,
} from "./discord/types.js";
import { initRoomyClient } from "./roomy/client.js";
import { createBot, Intents, InteractionTypes, MessageFlags } from "@discordeno/bot";
import { DISCORD_TOKEN } from "./env.js";
import { tracer, setDiscordAttrs, recordError } from "./tracing.js";
import {
  handleSlashCommandInteraction,
  handleComponentInteraction,
  slashCommands,
} from "./discord/slashCommands.js";
import { Deferred } from "@roomy/sdk";
import {
  bridgeConfigs,
  migrateBridgeConfigs,
} from "./repositories/LevelDBBridgeRepository.js";
import type { BridgeConfig } from "./repositories/BridgeRepository.js";
import { Bridge } from "./Bridge.js";
import { getProxyCacheBot } from "./discord/cache.js";

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
  /** Key: `${guildId}:${spaceId}` → Bridge instance */
  bridges = new Map<string, Bridge>();
  /** Pending interactive connection flows, keyed by `${guildId}:${spaceId}` */
  pendingConnections = new Map<
    string,
    { spaceId: StreamDid; timeout: NodeJS.Timeout }
  >();

  constructor() {
    this.start();
  }

  get appId() {
    if (this.state.current.state !== "ready")
      throw new Error("Bridge not ready");
    return this.state.current.appId;
  }

  /** Get all bridges for a given guild */
  getBridgesForGuild(guildId: bigint): Bridge[] {
    const prefix = `${guildId}:`;
    const result: Bridge[] = [];
    for (const [key, bridge] of this.bridges) {
      if (key.startsWith(prefix)) result.push(bridge);
    }
    return result;
  }

  /** Composite key for the bridges map */
  private bridgeKey(guildId: bigint | string, spaceId: string): string {
    return `${guildId}:${spaceId}`;
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

    // Run migration from old 1:1 store to new 1:N store
    await migrateBridgeConfigs();

    console.log("Subscribing to connected spaces...");
    const configs = await bridgeConfigs.list();

    console.log("bridge configs", configs);

    for (const config of configs) {
      const bridge = await Bridge.connect({
        spaceId: config.spaceId as StreamDid,
        guildId: BigInt(config.guildId),
        bot,
        client: roomy,
        config,
      });
      this.bridges.set(
        this.bridgeKey(config.guildId, config.spaceId),
        bridge,
      );
    }
    this.state.current = {
      state: "ready",
      roomy,
      bot,
      appId,
    };
    console.log("ready");
  }

  /**
   * A single instance of `bot` handles all events incoming from Discord across multiple guilds.
   * The event handlers route each event to Roomy spaces as defined in the persisted mapping.
   */
  async startBot() {
    const orchestrator = this;
    let appIdPromise = new Deferred<string>();
    const bot = getProxyCacheBot(
      createBot({
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

          // Handle slash commands and component interactions
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

            // Route component interactions (buttons, selects) to component handler
            if (
              interaction.type === InteractionTypes.MessageComponent
            ) {
              return handleComponentInteraction({
                interaction,
                guildId,
                orchestrator,
              });
            }

            const guildBridges = orchestrator.getBridgesForGuild(guildId);

            const spaceExists = async (did: StreamDid) => {
              return !!(await current.roomy.getSpaceInfo(did))?.name;
            };

            return handleSlashCommandInteraction({
              interaction,
              guildId,
              spaceExists,
              createBridge: orchestrator.createBridge.bind(orchestrator),
              deleteBridge: (spaceId: string) => {
                orchestrator.bridges.delete(
                  orchestrator.bridgeKey(guildId, spaceId),
                );
              },
              bridges: guildBridges,
            });
          },

          async channelCreate(channel) {
            await orchestrator.handleDiscordEvent("CHANNEL_CREATE", channel);
          },

          async threadCreate(channel) {
            await orchestrator.handleDiscordEvent("THREAD_CREATE", {
              ...channel,
              parentId: channel.parentId!,
            });
          },

          // Handle new messages
          async messageCreate(message) {
            await orchestrator.handleDiscordEvent("MESSAGE_CREATE", message);
          },

          // Handle reaction add
          async reactionAdd(payload) {
            await orchestrator.handleDiscordEvent("REACTION_ADD", payload);
          },

          // Handle reaction remove
          async reactionRemove(payload) {
            await orchestrator.handleDiscordEvent("REACTION_REMOVE", payload);
          },

          // Handle message edits
          async messageUpdate(message) {
            await orchestrator.handleDiscordEvent("MESSAGE_UPDATE", message);
          },

          // Handle message deletes
          async messageDelete(messageCtx) {
            await orchestrator.handleDiscordEvent("MESSAGE_DELETE", messageCtx);
          },
        },
      }),
    );
    bot.start();
    const appId = await appIdPromise.promise;
    return { bot, appId };
  }

  async createBridge(
    spaceId: StreamDid,
    guildId: bigint,
    config: BridgeConfig,
  ) {
    const current = await this.state.transitionedTo("ready");
    const bridge = await Bridge.connect({
      spaceId,
      bot: current.bot,
      guildId,
      client: current.roomy,
      config,
    });
    this.bridges.set(this.bridgeKey(guildId, spaceId), bridge);
    return bridge;
  }

  /**
   * Common handler wrapper with tracing and error handling.
   * Fans out Discord events to ALL bridges for the guild via Promise.all().
   */
  private async handleDiscordEvent<T extends DiscordEvent["event"]>(
    eventName: T,
    data: Omit<Extract<DiscordEvent, { event: T }>["payload"], "guildId"> & {
      guildId?: bigint;
    },
  ): Promise<void> {
    await this.state.transitionedTo("ready");
    if (!data.guildId) {
      console.warn(`Guild ID missing from ${eventName}`);
      return;
    }

    const guildBridges = this.getBridgesForGuild(data.guildId);
    if (guildBridges.length === 0) {
      console.warn(
        `No bridge found for guild ${data.guildId}, skipping ${eventName}`,
      );
      return;
    }

    console.log(
      `handling Discord event ${eventName} for ${guildBridges.length} bridge(s)`,
    );

    await Promise.all(
      guildBridges.map((bridge) =>
        tracer.startActiveSpan(`bridge.${eventName}`, async (span) => {
          setDiscordAttrs(span, { guildId: data.guildId! });
          try {
            await bridge.handleDiscordEvent({
              event: eventName,
              payload: data,
            } as unknown as DiscordEvent);
          } catch (error) {
            recordError(span, error);
            // Don't throw - fail gracefully
          } finally {
            span.end();
          }
        }),
      ),
    );
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
