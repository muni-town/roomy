import { ClassicLevel } from "classic-level";

const db = new ClassicLevel(process.env.DATA_DIR || "./data", {
  keyEncoding: "utf8",
  valueEncoding: "json",
});

export type Event<A extends string, B extends string> =
  | ({ type: "register" } & { [K in A | B]: string })
  | ({ type: "unregister" } & { [K in A | B]: string })
  | { type: "clear" };

/** Given two values, atomically creates lookup table entries for each to the other.
 * Allows subscribing to `register`, `unregister` and `clear` events.
 */
export type BidirectionalSublevelMap<A extends string, B extends string> = {
  register: (entry: { [K in A | B]: string }) => Promise<void>;
  unregister: (entry: { [K in A | B]: string }) => Promise<void>;
  subscribe: (onEvent: (event: Event<A, B>) => void) => void;
  list: () => Promise<{ [K in A | B]: string }[]>;
  clear: () => Promise<void>;
  sublevel: any;
} & {
  [K in `get_${A}`]: (b: string) => Promise<string | undefined>;
} & {
  [K in `get_${B}`]: (a: string) => Promise<string | undefined>;
};

function createBidirectionalSublevelMap<A extends string, B extends string>(
  sublevelName: string,
  aname: A,
  bname: B,
): BidirectionalSublevelMap<A, B> {
  const anameLtBname = (aname as string) < (bname as string);
  const sublevel = db.sublevel<string, string>(sublevelName, {
    keyEncoding: "utf8",
    valueEncoding: "utf8",
  });
  const subscribers: ((event: Event<A, B>) => void)[] = [];
  return {
    sublevel,
    /**
     * Sublevel that contains bidirectional mappings from Roomy space to Discord guild ID and
     * vise-versa.
     * */
    async [`get_${aname}`](b: string): Promise<string | undefined> {
      return await sublevel.get(bname + "_" + b);
    },
    async [`get_${bname}`](a: string): Promise<string | undefined> {
      return await sublevel.get(aname + "_" + a);
    },
    async unregister(entry: { [K in A | B]: string }) {
      const registeredA: string | undefined = await (
        this[`get_${aname}`] as any
      )(entry[bname]);
      const registeredB: string | undefined = await (
        this[`get_${bname}`] as any
      )(entry[aname]);
      if (registeredA != entry[aname] || registeredB != entry[bname]) {
        throw Error(
          `Cannot deregister ${aname}/${bname}: the provided pair isn't registered.`,
        );
      }
      await sublevel.batch([
        {
          type: "del",
          key: aname + "_" + entry[aname],
        },
        {
          type: "del",
          key: bname + "_" + entry[bname],
        },
      ]);

      for (const sub of subscribers) {
        sub({
          type: "unregister",
          [aname]: entry[aname],
          [bname]: entry[bname],
        });
      }
    },
    async list() {
      const opts = anameLtBname
        ? {
            gt: aname + "_",
            lt: bname + "_",
          }
        : {
            gt: this.aname,
          };
      const iter = sublevel.iterator(opts);
      const list = [];
      for await (const [key, value] of iter) {
        list.push({
          [aname]: key.replace(aname + "_", ""),
          [bname]: value.replace(bname + "_", ""),
        });
      }
      return list;
    },
    async subscribe(onEvent: (event: Event<A, B>) => void) {
      subscribers.push(onEvent);
    },
    async clear() {
      await sublevel.clear();
      for (const sub of subscribers) {
        sub({ type: "clear" });
      }
    },
    async register(entry: { [K in A | B]: string }) {
      // Make sure we haven't already registered a bridge for this guild or space.
      if (
        (await sublevel.has(aname + "_" + entry[aname])) ||
        (await sublevel.has(bname + "_" + entry[bname]))
      ) {
        throw new Error(`${aname} or ${bname} already registered.`);
      }

      await sublevel.batch([
        {
          key: aname + "_" + entry[aname],
          type: "put",
          value: entry[bname],
        },
        {
          key: bname + "_" + entry[bname],
          type: "put",
          value: entry[aname],
        },
      ]);

      for (const sub of subscribers) {
        sub({ type: "register", [aname]: entry[aname], [bname]: entry[bname] });
      }
    },
  } as any;
}

/** 2-way Map between guildIds and spaceIds */
export const registeredBridges = createBidirectionalSublevelMap(
  "registeredBridges",
  "guildId",
  "spaceId",
);

/** Access a KV store for a Discord guild-Roomy space mapping for latest messages.
 *
 * A `discordLatestMessageInChannelForBridge` instance for the
 * specific RoomySpace-DiscordGuild mapping, `latestMessagesInChannel`
 * is returned by `getGuildContext`, and this is used in
 * `messageCreate()` and `backfill()`
 */
export const discordLatestMessageInChannelForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) =>
  db.sublevel(
    `discordLatestMessageInChannel:${discordGuildId.toString()}:${roomySpaceId}`,
  );

export type LatestMessages = ReturnType<
  typeof discordLatestMessageInChannelForBridge
>;

/** Access a KV store for a Discord guild-Roomy space mapping for webhook tokens.
 *
 * Webhook tokens are created and used in `syncMessageFromRoomyToDiscord()` in the
 * `roomy` watcher, used in `syncDiscordMessageToRoomy()` in `discordBot` and
 * cleared in `slashCommands` where disconnecting the bot is handled.
 */
export const discordWebhookTokensForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) =>
  db.sublevel(
    `discordWebhookTokens:${discordGuildId.toString()}:${roomySpaceId}`,
  );

export type SyncedIds = ReturnType<typeof syncedIdsForBridge>;

/** 2-way Map of IDs between Discord and Roomy.
 * At first I thought this was just for users, but I'm pretty sure it
 * also maps between other entities, like Discord channels - Roomy
 * threads/rooms. For users we shouldn't need it as we now have
 * did-style `discord:12345` IDs which use the ID directly.
 */
export const syncedIdsForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) => {
  return createBidirectionalSublevelMap(
    `syncedIds:${discordGuildId.toString()}:${roomySpaceId}`,
    "discordId",
    "roomyId",
  );
};
