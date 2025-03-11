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
  /** The list of space IDs that the user has joined. */
  spaces: {
    /** The space's unique ID. */
    id: Ulid;
    /** The list of members known to have the space so that we can sync with them. */
    knownMembers: Did[];
  }[];
};

export type Ulid = string;
export type Did = string;

export type Message = {
  author: Did;
  content: string;
  reactions: { [reaction: string]: Did[] };
  replyTo?: Ulid;
  images?: {
    source: string;
    alt?: string;
  }[];
  softDeleted?: boolean;
};

export type Announcement = {
  kind: "messageMoved" | "messageDeleted" | "threadCreated";
  reactions: { [reaction: string]: Did[] };
  relatedMessages?: Ulid[];
  relatedThreads?: Ulid[];
  softDeleted?: boolean;
}

export type Thread = {
  title: string;
  timeline: Ulid[];
  relatedChannel: Ulid;
  softDeleted?: boolean;
};

// Used in DMs
// TODO: Delete since DMs are not in priority
export type DM = {
  name: string;
  description: string;
  messages: { [ulid: Ulid]: Message };
  threads: { [ulid: Ulid]: Thread };
  timeline: Ulid[];
};

export type Channel = {
  name: string;
  description?: string;
  avatar?: string;
  threads: Ulid[];
  timeline: Ulid[];
  softDeleted?: boolean;
};

export type SpaceCategory = {
  name: string;
  channels: Ulid[];
};
export type SidebarItem = { type: "category" | "channel"; id: Ulid };

export type Space = {
  admins: Ulid[];
  moderators: Ulid[];
  threads: { [ulid: Ulid]: Thread };
  channels: { [ulid: Ulid]: Channel };
  messages: { [ulid: Ulid]: Message | Announcement };
  categories: { [ulid: Ulid]: SpaceCategory };
  sidebarItems: SidebarItem[];
  name: string;
  description: string;
  avatarUrl: string;
};