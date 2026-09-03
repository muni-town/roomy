export type ThreadInfo = {
  id: string;
  name: string;
  kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
  channel?: string;
  canonicalParent?: string;
  channelName?: string;
  /**
   * Whether the room has messages the user hasn't read. Bold styling.
   * True for engaged-unread AND never-engaged rooms with content.
   */
  unread?: boolean;
  /**
   * Whether to show the accent dot (engaged-unread only). Never-engaged
   * rooms with content are bold (unread) but dotless — the user has never
   * opened them, so an unread marker would imply a read state they never
   * set. Channels always set this equal to `unread`.
   */
  unreadDot?: boolean;
  activity: {
    members: { avatar: string | null; name: string | null; id: string }[];
    latestTimestamp: number;
    /** Latest message preview (text-only) for the inbox-style sub-line. */
    latestMessage?: { id: string; text: string };
  };
};
