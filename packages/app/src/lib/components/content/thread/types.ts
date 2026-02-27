import type { Ulid, UserDid } from "@roomy/sdk";

export type Message = {
  id: Ulid;
  content: string;
  lastEdit: Ulid;
  // Canonical author (already resolved from override if present)
  authorDid: UserDid | null;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatar: string | null;
  // Canonical timestamp (milliseconds since epoch, resolved by materializer)
  timestamp: number;
  // Simple flag indicating if this is a bridged message
  isBridged: boolean;
  mergeWithPrevious: boolean | null;
  replyTo: Ulid[];
  forwardedFrom: Ulid | null;
  reactions: {
    reaction: string;
    userId: UserDid;
    userName: string;
    reactionId: Ulid;
  }[];
  media: {
    uri: string;
    mimeType: string;
    width?: number;
    height?: number;
    blurhash?: string;
    length?: number;
    size?: number;
    name?: string;
  }[];
  links: {
    uri: string;
    showPreview: boolean;
  }[];
  comment: {
    snippet?: string;
    version: Ulid | null;
    from: number | null;
    to: number | null;
  } | null;
  tags: {
    snowflake: string;
    name: string | null;
    handle: string | null;
    roomId: string | null;
  }[];
};
