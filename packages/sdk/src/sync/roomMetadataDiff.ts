/**
 * Hardcoded room-metadata-diff applicator.
 *
 * Companion to {@link applyMessageDiff} — patches cache entries from a
 * single `#roomMetadataDiff` frame for the unread-count fields, avoiding a
 * `getSpaces` / `space.getMetadata` / `room.getMetadata` refetch.
 *
 * The frame carries a `delta` (always `+1` per message), not an absolute
 * count — each patcher adds `delta` to the cached `unreadCount`. When the
 * cache entry is absent (`prev === undefined`) the patcher returns
 * `undefined`, which `setQueryData` treats as a no-op (it neither creates
 * nor deletes an entry). When the entry exists but the target isn't found
 * (e.g. the channel isn't in the sidebar), the patcher returns `prev`
 * unchanged — a harmless no-op rather than a destructive delete.
 *
 * The frame also carries per-user room-count deltas:
 *   - `roomUnreadDelta` — `+1` when a channel message makes a channel
 *     newly-unread for the user, `-1` when reading makes it fully-read.
 *     Patches `getSpaces[].unreadRoomCount` and
 *     `space.getMetadata.unreadRoomCount`.
 *   - `threadUnreadDelta` — same for engaged threads. Patches
 *     `getSpaces[].unreadThreadCount`, `space.getMetadata.unreadThreadCount`,
 *     and the parent channel's `room.getMetadata.unreadThreadCount`.
 *   - `parentChannelId` — the thread's parent channel, so the channel-scoped
 *     thread count can be patched.
 *
 * The patchers:
 *   - {@link patchRoomMetadata}        → `room.getMetadata` response (the room)
 *   - {@link patchChannelThreadCount} → `room.getMetadata` response (the
 *     parent channel's `unreadThreadCount`)
 *   - {@link patchSpaces}             → `getSpaces` response (the matching space)
 *   - {@link patchSpaceMetadata}      → `space.getMetadata` response (sidebar tree)
 */

import { Response as RoomMetadataResponseSchema } from "../schemas/queries/getRoomMetadata";
import { Response as GetSpacesResponseSchema, Space as SpaceSchema } from "../schemas/queries/getSpaces";
import {
  Response as SpaceMetadataResponseSchema,
  SidebarChannel as SidebarChannelSchema,
  SidebarCategory as SidebarCategorySchema,
} from "../schemas/queries/getSpaceMetadata";

type RoomMetadataResponse = typeof RoomMetadataResponseSchema.infer;
type GetSpacesResponse = typeof GetSpacesResponseSchema.infer;
type Space = typeof SpaceSchema.infer;
type SpaceMetadataResponse = typeof SpaceMetadataResponseSchema.infer;
type SidebarChannel = typeof SidebarChannelSchema.infer;
type SidebarCategory = typeof SidebarCategorySchema.infer;

export type {
  RoomMetadataResponse,
  GetSpacesResponse,
  SpaceMetadataResponse,
};

/** Per-user deltas carried by a `#roomMetadataDiff` frame. */
export interface RoomMetadataDiffPatch {
  /** The unread-count increment (`+1` per message) for the room itself. */
  delta: number;
  /** `+1`/`-1` for the space's channel-with-unreads count. */
  roomUnreadDelta?: number;
  /** `+1`/`-1` for the space's engaged-threads-with-unreads count. */
  threadUnreadDelta?: number;
  /** The thread's parent channel id (thread messages only). */
  parentChannelId?: string;
}

/**
 * Patch `room.getMetadata.unreadCount` by adding `delta`.
 * Returns `undefined` when there's no cached entry (no-op for
 * `setQueryData`); returns `prev` unchanged when the entry exists.
 */
export function patchRoomMetadata(
  prev: RoomMetadataResponse | undefined,
  patch: RoomMetadataDiffPatch,
): RoomMetadataResponse | undefined {
  if (!prev) return undefined;
  return { ...prev, unreadCount: prev.unreadCount + patch.delta };
}

/**
 * Patch a channel's `room.getMetadata.unreadThreadCount` by adding
 * `threadUnreadDelta`. Used for thread messages: the frame's `roomId` is the
 * thread, so the channel's own metadata entry (keyed by the channel id) is
 * patched separately. Returns `undefined` when there's no cached entry;
 * returns `prev` unchanged when the entry exists.
 */
export function patchChannelThreadCount(
  prev: RoomMetadataResponse | undefined,
  threadUnreadDelta: number,
): RoomMetadataResponse | undefined {
  if (!prev) return undefined;
  return { ...prev, unreadThreadCount: prev.unreadThreadCount + threadUnreadDelta };
}

/**
 * Patch the matching space's `unreadCount` in a `getSpaces` response by
 * adding `delta`, plus the rooms-with-unreads count by the per-user deltas.
 * (`getSpaces.unreadRoomCount` is the combined channels + engaged-threads
 * count the home cards show; the split lives on `space.getMetadata`.)
 * Returns `undefined` when there's no cached entry; returns `prev` unchanged
 * when the space isn't in the list.
 */
export function patchSpaces(
  prev: GetSpacesResponse | undefined,
  spaceId: string,
  patch: RoomMetadataDiffPatch,
): GetSpacesResponse | undefined {
  if (!prev) return undefined;
  let found = false;
  const spaces: Space[] = prev.spaces.map((space) => {
    if (space.id === spaceId) {
      found = true;
      return {
        ...space,
        unreadCount: space.unreadCount + patch.delta,
        unreadRoomCount:
          space.unreadRoomCount +
          (patch.roomUnreadDelta ?? 0) +
          (patch.threadUnreadDelta ?? 0),
      };
    }
    return space;
  });
  if (!found) return prev;
  return { spaces };
}

/**
 * Patch a `space.getMetadata` response: the channel entry's `unreadCount`
 * (by `roomId`), the matching active-thread entry's `unreadCount` (when
 * `parentChannelId` is present), and the top-level `unreadRoomCount` /
 * `unreadThreadCount` by the per-user deltas. Returns `undefined` when
 * there's no cached entry; returns `prev` unchanged when nothing matched.
 */
export function patchSpaceMetadata(
  prev: SpaceMetadataResponse | undefined,
  roomId: string,
  patch: RoomMetadataDiffPatch,
): SpaceMetadataResponse | undefined {
  if (!prev) return undefined;

  let touched = false;

  const patchChannel = (ch: SidebarChannel): SidebarChannel => {
    let out = ch;
    if (ch.id === roomId) {
      touched = true;
      out = { ...out, unreadCount: out.unreadCount + patch.delta };
    }
    // A thread message: bump the matching active-thread entry under its
    // parent channel (the thread may not be in the sidebar at all — the
    // active-threads list is capped — in which case this is a no-op).
    if (patch.parentChannelId && ch.id === patch.parentChannelId && out.activeThreads) {
      const threads = out.activeThreads.map((t) => {
        if (t.id === roomId) {
          touched = true;
          return { ...t, unreadCount: t.unreadCount + patch.delta };
        }
        return t;
      });
      if (threads !== out.activeThreads) out = { ...out, activeThreads: threads };
    }
    return out;
  };

  const categories: SidebarCategory[] = prev.sidebar.categories.map((cat) => ({
    ...cat,
    channels: cat.channels.map(patchChannel),
  }));
  const orphans = prev.sidebar.orphans.map(patchChannel);

  if (!touched && !patch.roomUnreadDelta && !patch.threadUnreadDelta) return prev;
  return {
    ...prev,
    unreadRoomCount: prev.unreadRoomCount + (patch.roomUnreadDelta ?? 0),
    unreadThreadCount: prev.unreadThreadCount + (patch.threadUnreadDelta ?? 0),
    sidebar: { categories, orphans },
  };
}
