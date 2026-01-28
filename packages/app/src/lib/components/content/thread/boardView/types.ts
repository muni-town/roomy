import type { Ulid } from "@roomy/sdk";

export type ThreadInfo = {
  id: string;
  name: string;
  kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
  channel?: string;
  canonicalParent?: Ulid; // Whether this is the canonical parent (first link)
  channelName?: string; // Canonical parent name (for display)
  activity: {
    members: { avatar: string | null; name: string | null; id: string }[];
    latestTimestamp: number;
  };
};
