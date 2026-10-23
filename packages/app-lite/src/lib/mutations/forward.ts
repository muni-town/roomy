/**
 * Forward planning: turning a multi-message selection into a destination
 * room's timeline.
 *
 * Two properties have to hold for the forwards to land in the source room's
 * order:
 *
 * 1. **Source order.** The selection list is kept in the order the user
 *    tapped it (see `toggleMessageSelection`), so forwarding it verbatim
 *    cross-posts the messages in click order. Targets are therefore sorted by
 *    the same timeline key the appserver pages a room by,
 *    `coalesce(sort_idx, id)`.
 *
 * 2. **A total order within the burst.** A forward burst is minted inside one
 *    millisecond, so every forward shares a canonical time. `sort_idx` breaks
 *    that tie by the event's log position (`materialization/sortIdx.ts`), so
 *    the destination orders the forwards exactly as this batch sent them —
 *    no client-side timestamp is needed, and none is sent: `timestampOverride`
 *    rewrites a message's timeline position, which is a space-admin
 *    extension, not something an ordinary sender may set.
 *
 * Kept free of Svelte and the network so the rule stays unit-testable.
 */

import { newUlid, serializeBlocks, toBytes } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";

/** The appserver's per-`sendEvents` cap (`space.roomy.space.sendEvents`). */
export const MAX_EVENTS_PER_SEND = 50;

/** A message being forwarded, identified as the source room orders it. */
export interface ForwardTarget {
  id: string;
  /** The source room's timeline key. Absent for unsorted system messages. */
  sort_idx?: string;
}

/**
 * Order forward targets oldest → newest, matching the source room's timeline.
 *
 * Ties keep their input order, so a target with no `sort_idx` (a system
 * message) sorts by its id — the appserver's own fallback.
 */
export function orderForwardTargets(
  targets: readonly ForwardTarget[],
): ForwardTarget[] {
  return [...targets].sort((a, b) => {
    const aKey = a.sort_idx ?? a.id;
    const bKey = b.sort_idx ?? b.id;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/**
 * Build the `createMessage` events that forward `targets` into `toRoomId`,
 * in the order they appear in the source room's timeline.
 *
 * The events carry only the forward attachment. Their order in this array is
 * the order they reach the log, and the log position breaks the tie between
 * forwards sharing a millisecond, so the destination pages them in exactly
 * that order without any timestamp of the client's own.
 */
export function buildForwardEvents(
  fromRoomId: string,
  toRoomId: string,
  targets: readonly ForwardTarget[],
  blocks: Block[],
): Record<string, unknown>[] {
  const serialized = serializeBlocks(blocks);
  return orderForwardTargets(targets).map((target) => ({
    id: newUlid(),
    room: toRoomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: serialized.mimeType, data: toBytes(serialized.data) },
    extensions: {
      "space.roomy.extension.attachments.v0": {
        $type: "space.roomy.extension.attachments.v0",
        attachments: [
          {
            $type: "space.roomy.attachment.forward.v0",
            target: target.id,
            fromRoomId,
          },
        ],
      },
    },
  }));
}
