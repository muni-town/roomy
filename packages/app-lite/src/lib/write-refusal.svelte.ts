/**
 * Room-write refusals, corrected where the composer observes them.
 *
 * Every query holds `staleTime: Infinity` and is refreshed by WebSocket
 * invalidation alone, so a `canWrite` that was true when the room's metadata
 * loaded stays true until something invalidates it. A grant revoked while the
 * app is open therefore leaves an enabled composer whose every send the
 * appserver refuses with `Caller does not have write access to this room`.
 *
 * That refusal is the same access decision the composer already renders, so it
 * is handled as one rather than as a generic delivery failure: the metadata
 * behind `canWrite` is invalidated, and the composer takes the permission
 * notice it shows for `canWrite === false`.
 *
 * A refused room stays refused until a metadata fetch that landed *after* the
 * refusal reports it writable. Nothing here polls: the fetch is the one the
 * invalidation already triggers, and grant changes reach the client as
 * WebSocket invalidations of the same two queries. Because the composer and the
 * retry affordance both read this state, one revocation costs one refused send
 * rather than one per press, and a grant restored mid-session brings the
 * composer back without a reload.
 *
 * Kept free of the QueryClient and of Svelte components so the rule stays
 * unit-testable; the invalidation is passed in (see `recoverFromWriteRefusal`).
 */

import { cache } from "@roomy-space/sdk";
import { SvelteMap } from "svelte/reactivity";

const SEND_EVENTS_NSID = "space.roomy.space.sendEvents";
const ROOM_METADATA_NSID = "space.roomy.room.getMetadata";
const SPACE_METADATA_NSID = "space.roomy.space.getMetadata";

/** Rooms that refused a write, valued by when they refused it. */
const refusedAt = new SvelteMap<string, number>();

/** The `status`/`nsid` fields `DirectXrpcClient` attaches to a failed XRPC call. */
function xrpcFailure(
  err: unknown,
): { status: number; nsid: string | undefined } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (!("status" in err) || typeof err.status !== "number") return undefined;
  return {
    status: err.status,
    nsid: "nsid" in err && typeof err.nsid === "string" ? err.nsid : undefined,
  };
}

/**
 * True when `err` is the appserver refusing a write to a room — the
 * `sendEvents` procedure answered 403.
 *
 * Matched on the NSID and status the transport attaches, never on the prose:
 * that message is the server's to change, and every reason a caller cannot
 * write (no grant, not a member, banned) means the same thing here — this
 * caller cannot post to the room they just tried to post to.
 */
export function isWriteRefusal(err: unknown): boolean {
  const failure = xrpcFailure(err);
  return (
    failure !== undefined &&
    failure.nsid === SEND_EVENTS_NSID &&
    failure.status === 403
  );
}

/**
 * Whether `roomId` is refusing writes. Reactive: `SvelteMap` membership is a
 * dependency, so a `$derived` reading it re-runs when the room is refused.
 */
export function writeRefused(roomId: string): boolean {
  return refusedAt.has(roomId);
}

/**
 * What the composer offers for `roomId`: `false` is the shell's permission
 * notice, so a refused room does not offer Send again on the unchanged grant.
 */
export function composerCanWrite(
  roomId: string,
  serverCanWrite: boolean | undefined,
): boolean | undefined {
  return writeRefused(roomId) ? false : serverCanWrite;
}

/**
 * Drop the refusal when a metadata fetch that landed after it reports the room
 * writable — the only thing that disproves a refusal.
 *
 * `canWriteUpdatedAt` is the fetch stamp of whichever query supplies `canWrite`
 * (see `composerCanWrite`'s caller); it advances only on a successful fetch, so
 * a failed refetch cannot re-enable the composer. A fetch that itself reports
 * `canWrite !== true` is the same denial the send hit, so it keeps the refusal
 * — which is what holds the retry affordance back until access is actually
 * back.
 */
export function refreshWriteRefusal(
  roomId: string,
  canWriteUpdatedAt: number,
  canWrite: boolean | undefined,
): void {
  const refused = refusedAt.get(roomId);
  if (refused === undefined) return;
  if (canWrite !== true) return;
  if (canWriteUpdatedAt < refused) return;
  refusedAt.delete(roomId);
}

/** The `invalidateQueries` shape this module drives (TanStack's own method). */
export interface QueryInvalidator {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}

/**
 * The catch path of a send. Returns `true` when `err` was a write refusal, in
 * which case the room is refused and the metadata behind `canWrite` is
 * invalidated — and the caller must NOT also report a generic send failure.
 *
 * The space metadata is invalidated by NSID rather than by id: the sidebar
 * entry that supplies `canWrite` first is built by the space whose metadata
 * holds it, which for a federated room is the origin space, not the space the
 * composer was given.
 */
export function recoverFromWriteRefusal(
  err: unknown,
  roomId: string,
  invalidator: QueryInvalidator,
): boolean {
  if (!isWriteRefusal(err)) return false;
  refusedAt.set(roomId, Date.now());
  invalidator.invalidateQueries({
    queryKey: cache.queryKey(ROOM_METADATA_NSID, { roomId }),
  });
  invalidator.invalidateQueries({ queryKey: [SPACE_METADATA_NSID] });
  return true;
}
