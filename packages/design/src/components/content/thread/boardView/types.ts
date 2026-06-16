import type { Ulid } from "@roomy-space/sdk";

export type ThreadMessage = {
  id: string;
  content: string;
  author: {
    did: string;
    name?: string;
    avatar?: string;
  };
  timestamp?: string;
};

export type ThreadInfo = {
  id: string;
  name: string;
  kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
  channel?: string;
  canonicalParent?: Ulid;
  channelName?: string;
  unreadCount?: number;
  activity: {
    members: { avatar: string | null; name: string | null; id: string }[];
    latestTimestamp: number;
    latestMessage?: ThreadMessage | null;
  };
};
