import type {
  RoomSummaryResolver,
  SpaceSummaryResolver,
} from "./embeds/types.js";

/** A space/room reference an internal link names. */
export interface InternalLinkTarget {
  spaceId: string;
  roomId?: string;
}

/**
 * What the internal-link renderer needs from the client it runs in.
 *
 * Every rendered message body is scanned for links that name a space or room
 * and each is replaced with a {@link SpaceRoomBadge}. The scan is
 * presentational — it reads the DOM it is handed — but three of its inputs
 * belong to the client: which origins count as this deployment's own, how a
 * space/room summary is looked up, and which space the reader is currently
 * in. They arrive here rather than being imported, so no component in this
 * directory reaches an XRPC client or an app's route state.
 *
 * Injected once at boot (`configureInternalLinks`), because the renderer runs
 * as a `use:` action and as a facet walk rather than as a component that
 * could take props: the badge is mounted imperatively, one instance per link,
 * so a prop would have to be threaded through the mount call anyway.
 */
export interface InternalLinksConfig {
  /**
   * Origins an absolute link may be rooted at to name a space this client can
   * look up — the document's own origin and the web origin of the appserver
   * it talks to. Also handed to the markdown renderer
   * (`setInternalLinkOrigins`), which marks links as it renders them.
   */
  origins: readonly string[];
  /**
   * Looks up a space's display fields for an internal link. The client owns
   * the lookup, so it also owns the request policy: caching, error semantics,
   * and how many times a permanently-failing key may be asked.
   */
  resolveSpace: SpaceSummaryResolver;
  /** Looks up a room's display fields for an internal link. */
  resolveRoom?: RoomSummaryResolver;
  /**
   * Whether the space a link names is the one the reader is currently in. That
   * badge is suppressed to a plain label — repeating the space's own name
   * inside its own messages says nothing.
   *
   * Read through on every render rather than captured: navigating between
   * spaces reuses a mounted badge, and the suppression must follow.
   */
  isCurrentSpace?: (spaceId: string) => boolean;
}
