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

export type SidebarCategory = Extract<
  SidebarItem,
  { type: "space.roomy.category" }
>;

export type SidebarItem = {
  id: string;
  name: string;
  parent?: string;
  lastRead: number;
  latestEntity: number;
  unreadCount: number;
  sortIdx: string;
} & (
  | {
      type: "space.roomy.category";
      children: (ChannelTreeItem | PageTreeItem)[];
    }
  | {
      type: "space.roomy.channel";
      children?: (ThreadTreeItem | PageTreeItem)[];
    }
  | {
      type: "space.roomy.thread";
      children?: PageTreeItem[];
    }
  | {
      type: "space.roomy.page";
    }
);

type ChannelTreeItem = Extract<SidebarItem, { type: "space.roomy.channel" }>;
type ThreadTreeItem = Extract<SidebarItem, { type: "space.roomy.thread" }>;
type PageTreeItem = Extract<SidebarItem, { type: "space.roomy.page" }>;
