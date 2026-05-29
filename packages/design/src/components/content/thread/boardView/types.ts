import type { Ulid } from "@roomy-space/sdk";

export type ThreadInfo = {
  id: string;
  name: string;
  kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
  channel?: string;
  canonicalParent?: Ulid;
  channelName?: string;
  activity: {
    members: { avatar: string | null; name: string | null; id: string }[];
    latestTimestamp: number;
  };
};
