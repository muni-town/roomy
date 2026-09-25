/**
 * Frame-to-cache router.
 *
 * Subscribes to a {@link SyncConnection}'s frame stream and dispatches each
 * decoded frame into the supplied {@link CacheAdapter}:
 *
 *  - `#invalidate` → `adapter.invalidate(queryKey(nsid, params))`
 *  - `#messageDiff` → `adapter.patch(queryKey(GET_MESSAGES_NSID, { roomId }),
 *                                    prev => applyMessageDiff(prev, ops))`
 *
 * The per-frame dispatch is hardcoded rather than registered through a
 * pluggable table — there is one diffable surface. `applyMessageDiff`
 * tolerates `undefined` prev, because a diff frame can race ahead of the
 * initial fetch.
 */
import { type } from "arktype";
import { Body as InvalidateBody } from "../schemas/frames/invalidate";
import { Body as MessageDiffBody } from "../schemas/frames/messageDiff";
import { Body as RoomMetadataDiffBody } from "../schemas/frames/roomMetadataDiff";
import { Body as RoomActivityDiffBody } from "../schemas/frames/roomActivityDiff";
import type { CacheAdapter, QueryKey } from "../cache/adapter";
import { queryKey } from "../cache/query-key";
import { applyMessageDiff, type Message } from "./diff";
import {
  patchRoomMetadata,
  patchChannelThreadCount,
  patchSpaces,
  patchSpaceMetadata,
  type RoomMetadataDiffPatch,
  type RoomMetadataResponse,
  type GetSpacesResponse,
  type SpaceMetadataResponse,
} from "./roomMetadataDiff";
import {
  patchSpaceBoard,
  patchRoomBoard,
  patchRecentThreads,
  patchSpaceBoardUnread,
  patchRoomBoardUnread,
  type RoomActivityPatch,
  type InfiniteData,
  type SpaceThreadsData,
  type RoomThreadsData,
} from "./roomActivityDiff";
import type { SyncConnection, SyncFrame, Unsubscribe } from "./connection";

const GET_MESSAGES_NSID = "space.roomy.room.getMessages" as const;
const ROOM_METADATA_NSID = "space.roomy.room.getMetadata" as const;
const GET_SPACES_NSID = "space.roomy.space.getSpaces" as const;
const SPACE_METADATA_NSID = "space.roomy.space.getMetadata" as const;
const SPACE_THREADS_NSID = "space.roomy.space.getThreads" as const;
const ROOM_THREADS_NSID = "space.roomy.room.getThreads" as const;

export interface SyncRouterOptions {
  /**
   * Called when a frame fails arktype validation. Defaults to a no-op so
   * the router never throws into the WS message handler. Consumers
   * (especially during dev) typically pass a `console.warn`-like callback.
   */
  onValidationError?: (info: {
    frameType: string;
    summary: string;
    raw: Record<string, unknown>;
  }) => void;
  /** Called for frames whose `header.t` we don't know how to route. */
  onUnknownFrame?: (frame: SyncFrame) => void;
}

export class SyncRouter {
  readonly #connection: SyncConnection;
  readonly #adapter: CacheAdapter;
  readonly #opts: SyncRouterOptions;
  #unsubscribe: Unsubscribe | null = null;

  constructor(
    connection: SyncConnection,
    adapter: CacheAdapter,
    opts: SyncRouterOptions = {},
  ) {
    this.#connection = connection;
    this.#adapter = adapter;
    this.#opts = opts;
  }

  /** Begin routing frames. Returns the unsubscribe handle (also storable via `stop()`). */
  start(): Unsubscribe {
    if (this.#unsubscribe) return this.#unsubscribe;
    const unsub = this.#connection.onFrame((frame) => this.#route(frame));
    this.#unsubscribe = () => {
      unsub();
      this.#unsubscribe = null;
    };
    return this.#unsubscribe;
  }

  /** Stop routing. Idempotent. */
  stop(): void {
    this.#unsubscribe?.();
  }

  #route(frame: SyncFrame): void {
    const t = frame.header["t"];
    if (typeof t !== "string") {
      this.#opts.onUnknownFrame?.(frame);
      return;
    }

    if (t === "#invalidate") {
      const parsed = InvalidateBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      this.#adapter.invalidate(queryKey(parsed.nsid, parsed.params));
      return;
    }

    if (t === "#messageDiff") {
      const parsed = MessageDiffBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      this.#adapter.patch<Message[]>(
        queryKey(GET_MESSAGES_NSID, { roomId: parsed.roomId }),
        (prev) => applyMessageDiff(prev, parsed.ops),
      );
      return;
    }

    if (t === "#roomMetadataDiff") {
      const parsed = RoomMetadataDiffBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      const patch: RoomMetadataDiffPatch = {
        delta: parsed.delta,
        roomUnreadDelta: parsed.roomUnreadDelta,
        threadUnreadDelta: parsed.threadUnreadDelta,
        parentChannelId: parsed.parentChannelId,
      };
      // Patch cache entries from the one frame. Each patcher returns
      // undefined when its cache entry is absent or the target isn't found —
      // a no-op (`setQueryData` treats undefined as "don't write").
      this.#adapter.patch<RoomMetadataResponse>(
        queryKey(ROOM_METADATA_NSID, { roomId: parsed.roomId }),
        (prev) => patchRoomMetadata(prev, patch),
      );
      // A thread message also bumps the parent channel's thread count.
      if (parsed.parentChannelId && parsed.threadUnreadDelta) {
        this.#adapter.patch<RoomMetadataResponse>(
          queryKey(ROOM_METADATA_NSID, { roomId: parsed.parentChannelId }),
          (prev) => patchChannelThreadCount(prev, parsed.threadUnreadDelta!),
        );
      }
      // Patch every cached variant of getSpaces (the server bar caches
      // `?includeLeft=true`, the home page the bare query). `patchAll`
      // prefix-matches rather than requiring the exact key, so a single
      // frame updates every mounted variant; no cache entry = no-op.
      this.#adapter.patchAll<GetSpacesResponse>(
        queryKey(GET_SPACES_NSID),
        (prev) => patchSpaces(prev, parsed.spaceId, patch),
      );
      this.#adapter.patch<SpaceMetadataResponse>(
        queryKey(SPACE_METADATA_NSID, { spaceId: parsed.spaceId }),
        (prev) => patchSpaceMetadata(prev, parsed.roomId, patch),
      );
      // The boards render `unreadCount`/`unread` per row too, and those fields
      // are absent from #roomActivityDiff (they are caller-scoped) — so patch
      // them from this per-user frame, exactly like the sidebar above. A
      // message in a thread bumps the THREAD's row, not the channel's, so the
      // space board is patched with the room that actually received it.
      this.#adapter.patch<Parameters<typeof patchSpaceBoardUnread>[0]>(
        queryKey(SPACE_THREADS_NSID, { spaceId: parsed.spaceId }),
        (prev) => patchSpaceBoardUnread(prev, parsed.roomId, parsed.delta),
      );
      if (parsed.parentChannelId) {
        this.#adapter.patch<Parameters<typeof patchRoomBoardUnread>[0]>(
          queryKey(ROOM_THREADS_NSID, { roomId: parsed.parentChannelId }),
          (prev) => patchRoomBoardUnread(prev, parsed.roomId, parsed.delta),
        );
      }
      return;
    }

    if (t === "#roomActivityDiff") {
      const parsed = RoomActivityDiffBody(frame.body);
      if (parsed instanceof type.errors) {
        this.#opts.onValidationError?.({
          frameType: t,
          summary: parsed.summary,
          raw: frame.body,
        });
        return;
      }
      this.#applyRoomActivityDiff(parsed);
      return;
    }

    this.#opts.onUnknownFrame?.(frame);
  }

  /**
   * Apply a `#roomActivityDiff`: the room's board row moved to the front of
   * every activity-ordered view that shows it.
   *
   * Each view is either patched in place or invalidated, never both:
   *   - the space board and the parent channel's thread board are PAGES, and a
   *     patch is only faithful when the room is on the cached first page and
   *     the message advanced its timestamp (see `roomActivityDiff.ts`). When it
   *     isn't, the query is invalidated — the pre-diff behaviour.
   *   - `recentThreads` exists only on the parent channel's metadata, and only
   *     for threads, so a channel message leaves it untouched.
   */
  #applyRoomActivityDiff(patch: RoomActivityPatch): void {
    this.#applyOrInvalidate<InfiniteData<SpaceThreadsData>>(
      queryKey(SPACE_THREADS_NSID, { spaceId: patch.spaceId }),
      (prev) => patchSpaceBoard(prev, patch),
    );

    // Threads only: the parent channel's board and its in-chat thread list.
    const parentId = patch.parentChannelId;
    if (!parentId) return;

    this.#applyOrInvalidate<InfiniteData<RoomThreadsData>>(
      queryKey(ROOM_THREADS_NSID, { roomId: parentId }),
      (prev) => patchRoomBoard(prev, patch),
    );

    const parentMetaKey = queryKey(ROOM_METADATA_NSID, { roomId: parentId });
    this.#adapter.patch<RoomMetadataResponse>(parentMetaKey, (prev) =>
      patchRecentThreads(prev, patch),
    );
  }

  /**
   * Patch a cached entry from a diff, or invalidate it when the diff cannot
   * represent the resulting state (the applicator returns `undefined`).
   *
   * Reading first is what makes the choice possible: an absent entry needs
   * neither (nothing is cached to correct), while a present-but-unapplicable
   * one must refetch rather than be left with a stale order.
   */
  #applyOrInvalidate<T>(key: QueryKey, apply: (prev: T | undefined) => T | undefined): void {
    const prev = this.#adapter.get<T>(key);
    if (prev === undefined) return;
    const next = apply(prev);
    if (next === undefined) {
      this.#adapter.invalidate(key);
      return;
    }
    this.#adapter.patch<T>(key, () => next);
  }
}
