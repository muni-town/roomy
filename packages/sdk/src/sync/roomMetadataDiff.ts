/**
 * Hardcoded room-metadata-diff applicator.
 *
 * Companion to {@link applyMessageDiff} — patches three cache entries from a
 * single `#roomMetadataDiff` frame so message-create no longer forces a
 * `getSpaces` / `space.getMetadata` / `room.getMetadata` refetch for the
 * unread-count field.
 *
 * The frame carries a `delta` (always `+1` per message), not an absolute
 * count — each patcher adds `delta` to the cached `unreadCount`. When the
 * cache entry is absent (`prev === undefined`) the patcher returns
 * `undefined`, which `setQueryData` treats as a no-op (it neither creates
 * nor deletes an entry). When the entry exists but the target isn't found
 * (e.g. the channel isn't in the sidebar), the patcher returns `prev`
 * unchanged — a harmless no-op rather than a destructive delete.
 *
 * The three patchers:
 *   - {@link patchRoomMetadata}  → `room.getMetadata` response
 *   - {@link patchSpaces}        → `getSpaces` response (the matching space)
 *   - {@link patchSpaceMetadata} → `space.getMetadata` response (sidebar tree)
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

/**
 * Patch `room.getMetadata.unreadCount` by adding `delta`.
 * Returns `undefined` when there's no cached entry (no-op for
 * `setQueryData`); returns `prev` unchanged when the entry exists.
 */
export function patchRoomMetadata(
  prev: RoomMetadataResponse | undefined,
  delta: number,
): RoomMetadataResponse | undefined {
  if (!prev) return undefined;
  return { ...prev, unreadCount: prev.unreadCount + delta };
}

/**
 * Patch the matching space's `unreadCount` in a `getSpaces` response by
 * adding `delta`. Returns `undefined` when there's no cached entry; returns
 * `prev` unchanged when the space isn't in the list.
 */
export function patchSpaces(
  prev: GetSpacesResponse | undefined,
  spaceId: string,
  delta: number,
): GetSpacesResponse | undefined {
  if (!prev) return undefined;
  let found = false;
  const spaces: Space[] = prev.spaces.map((space) => {
    if (space.id === spaceId) {
      found = true;
      return { ...space, unreadCount: space.unreadCount + delta };
    }
    return space;
  });
  if (!found) return prev;
  return { spaces };
}

/**
 * Patch the channel entry in a `space.getMetadata` sidebar tree by adding
 * `delta` to its `unreadCount`. Walks `sidebar.categories[].channels[]` and
 * `sidebar.orphans[]` to find the channel by `roomId`. Returns `undefined`
 * when there's no cached entry; returns `prev` unchanged when the channel
 * isn't in the sidebar (the caller may have no read access to it, or the
 * room is a thread not shown at the channel level).
 */
export function patchSpaceMetadata(
  prev: SpaceMetadataResponse | undefined,
  roomId: string,
  delta: number,
): SpaceMetadataResponse | undefined {
  if (!prev) return undefined;

  let touched = false;

  const patchChannel = (ch: SidebarChannel): SidebarChannel => {
    if (ch.id === roomId) {
      touched = true;
      return { ...ch, unreadCount: ch.unreadCount + delta };
    }
    return ch;
  };

  const categories: SidebarCategory[] = prev.sidebar.categories.map((cat) => ({
    ...cat,
    channels: cat.channels.map(patchChannel),
  }));
  const orphans = prev.sidebar.orphans.map(patchChannel);

  if (!touched) return prev;
  return {
    ...prev,
    sidebar: { categories, orphans },
  };
}