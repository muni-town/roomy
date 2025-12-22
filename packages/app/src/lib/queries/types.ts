import type { Handle, StreamDid, UserDid } from "$lib/schema";

export type SpaceMeta = {
  id: StreamDid;
  backfill_status: "loading" | "idle" | "error";
  joined?: boolean;
  name?: string;
  avatar?: string;
  handle_account?: UserDid;
  handle?: Handle;
  description?: string;
  permissions: [string, "read" | "post" | "admin"][];
};

export type SpaceTreeItem = {
  id: string;
  name: string;
  parent?: string;
  lastRead: number;
  latestEntity: number;
  unreadCount: number;
} & (
  | {
      type: "category";
      children: (ChannelTreeItem | PageTreeItem)[];
    }
  | {
      type: "channel";
      children?: (ThreadTreeItem | PageTreeItem)[];
    }
  | {
      type: "thread";
      children?: PageTreeItem[];
    }
  | {
      type: "page";
    }
);

type ChannelTreeItem = Extract<SpaceTreeItem, { type: "channel" }>;
type ThreadTreeItem = Extract<SpaceTreeItem, { type: "thread" }>;
type PageTreeItem = Extract<SpaceTreeItem, { type: "page" }>;
