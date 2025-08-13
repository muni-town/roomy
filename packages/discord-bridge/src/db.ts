import { ClassicLevel } from "classic-level";

const db = new ClassicLevel(process.env.DATA_DIR || "./data", {
  keyEncoding: "utf8",
  valueEncoding: "json",
});

type BidirectionalSublevelMap<A extends string, B extends string> = {
  register: (entry: { [K in A | B]: string }) => Promise<void>;
  unregister: (entry: { [K in A | B]: string }) => Promise<void>;
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
  return {
    /**
     * Sublevel that contains bidirectional mappings from Roomy space to Discord guild ID and
     * vise-versa.
     * */
    sublevel: db.sublevel<string, string>(sublevelName, {
      keyEncoding: "utf8",
      valueEncoding: "utf8",
    }),
    async [`get_${aname}`](b: string): Promise<string | undefined> {
      return await this.sublevel.get(bname + "_" + b);
    },
    async [`get_${bname}`](a: string): Promise<string | undefined> {
      return await this.sublevel.get(aname + "_" + a);
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
      await this.sublevel.batch([
        {
          type: "del",
          key: aname + "_" + entry[aname],
        },
        {
          type: "del",
          key: bname + "_" + entry[bname],
        },
      ]);
    },
    async clear() {
      await this.sublevel.clear();
    },
    async register(entry: { [K in A | B]: string }) {
      // Make sure we haven't already registered a bridge for this guild or space.
      if (
        (await this.sublevel.has(aname + "_" + entry[aname])) ||
        (await this.sublevel.has(bname + "_" + entry[bname]))
      ) {
        throw new Error(`${aname} or ${bname} already registered.`);
      }

      this.sublevel.batch([
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
    },
  } as any;
}

export const registeredBridges = createBidirectionalSublevelMap(
  "registeredBridges",
  "guildId",
  "spaceId",
);

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
