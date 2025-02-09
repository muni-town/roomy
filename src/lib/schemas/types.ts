import type * as Automerge from "npm:@automerge/automerge";

/** The user's index of all of the chats that they have joined. */
export type Catalog = {
  /** Direct messages to other users. */
  dms: {
    [
      /** The DID of the user that the DM is with. */
      did: string
    ]: {
      /** The name associated to the direct message, usually the handle of the user. */
      name: string;

      /** The avatar URL string, optional */
      avatar?: string;

      /**
       * The latest version of the DM that the user has viewed.
       * Used to calculate the unread messages count.
       */
      viewedHeads?: Automerge.Heads;
    };
  };
};

export type Ulid = string;
export type Did = string;

export type Message = {
  author: Did;
  content: string;
  replyTo?: Ulid;
  reactions: { [reaction: string]: Did[] };
};

export type Thread = {
  title: string;
  timeline: Ulid[];
};

export type Channel = {
  name: string;
  description: string;
  messages: { [ulid: Ulid]: Message };
  threads: { [ulid: Ulid]: Thread };
  timeline: Ulid[];
};

export type SpaceChannel = {
  name: string;
  description?: string;
  avatar?: string;
  threads: Ulid[];
  timeline: Ulid[];
};
export type SpaceCategory = {
  name: string;
  channels: Ulid[];
};
export type SidebarItem = { type: "category" | "channel"; id: Ulid };

export type Space = {
  threads: { [ulid: Ulid]: Thread };
  messages: { [ulid: Ulid]: Message };
  channels: { [ulid: Ulid]: SpaceChannel };
  categories: { [ulid: Ulid]: SpaceCategory };
  sidebarItems: SidebarItem[];
  name: string;
  description: string;
};
