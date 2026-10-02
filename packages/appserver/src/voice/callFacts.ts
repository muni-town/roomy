/**
 * Call facts: the one place call lifecycle transitions become events.
 *
 * Three paths produce transitions — explicit client intent (`user`), LiveKit
 * webhooks (`livekit`), and the reconciler (`reconciliation`) — and all three
 * go through this module. That is what makes the collapse rules uniform: a
 * webhook repeating a join the client already recorded is a no-op, not a
 * second participant row, and the projection is the same whichever path got
 * there first.
 *
 * Facts are written through the ordinary `sendEvents` pipeline, so they are
 * durable, replayable, and invalidate queries like any other event.
 */

import { newUlid, parseEvent, StreamDid } from "@roomy-space/sdk";
import type { CallFactSource, Event, Ulid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { activeCall, participantsIn } from "./projection.ts";

export interface CallFactActor {
  /** The participant the fact is about. */
  did: string;
  /** The space DID whose stream carries the fact. */
  spaceId: StreamDid;
  /** The room the call belongs to. Validated by {@link build} when the fact
   *  is constructed, so a malformed id fails at the call site, not at the
   *  write. */
  roomId: string;
  /**
   * The call generation to act on. Omitted by the paths that act on whatever
   * call the room currently has (client intent); the webhook and reconciler
   * pass the generation they observed, so a correction can never land on a
   * call that replaced the one it was derived from.
   */
  callId?: string;
}

/**
 * The room's active call, started if it has none.
 *
 * Called by `getToken` so a client can mint a token and connect before anyone
 * has announced a join — the LiveKit room exists once the client connects
 * regardless, and a call whose participants are not yet recorded is the
 * accurate state at that moment.
 */
export async function ensureCall(
  db: DbLike,
  actor: CallFactActor,
  source: CallFactSource,
): Promise<string> {
  const current = await activeCall(db, actor.roomId);
  if (current) return current.callId;

  const callId = newUlid();
  await writeFacts(
    actor,
    [callStarted(actor, callId, source)],
  );
  return callId;
}

export async function recordJoin(
  db: DbLike,
  actor: CallFactActor,
  source: CallFactSource,
): Promise<void> {
  const current = await activeCall(db, actor.roomId);

  // An explicitly named generation that is not the room's current one is
  // stale: a webhook for a call the room has already ended and replaced. It is
  // dropped, not written — resurrecting a superseded generation would put the
  // room back on a call nobody is in.
  if (actor.callId !== undefined && actor.callId !== current?.callId) return;

  const callId = current?.callId ?? newUlid();

  if (current?.callId === callId) {
    const participants = await participantsIn(db, actor.roomId, callId);
    if (participants.has(actor.did)) return;
  }

  // With no active call the join starts one, so the participant's fact is
  // never written against a call that does not exist.
  const events: Event[] = current
    ? []
    : [callStarted(actor, callId, source)];
  events.push(
    build({
      $type: "space.roomy.voice.callJoined.v0",
      room: actor.roomId,
      callId,
      userDid: actor.did,
      source,
    }),
  );
  await writeFacts(actor, events);
}

/**
 * Record a leave. Ends the call when the departing participant was the last
 * one — the same rule the webhook and the reconciler apply, so the projection
 * does not depend on which path observed the empty room first.
 *
 * Idempotent: a leave for a participant not in the room's call is a no-op, and
 * a leave naming a superseded generation is dropped.
 */
export async function recordLeave(
  db: DbLike,
  actor: CallFactActor,
  source: CallFactSource,
): Promise<void> {
  const current = await activeCall(db, actor.roomId);
  if (!current) return;
  if (actor.callId !== undefined && actor.callId !== current.callId) return;

  const callId = current.callId;
  const participants = await participantsIn(db, actor.roomId, callId);
  if (!participants.has(actor.did)) return;

  const events: Event[] = [
    build<"space.roomy.voice.callLeft.v0">({
      $type: "space.roomy.voice.callLeft.v0",
      room: actor.roomId,
      callId,
      userDid: actor.did,
      source,
    }),
  ];
  if (participants.size === 1) {
    events.push(callEnded(actor, callId, source));
  }

  await writeFacts(actor, events);
}

/**
 * End the room's call outright, whoever is in it. Used when the call is known
 * to be over (LiveKit reports the room finished, or the reconciler found it
 * missing or empty) rather than inferred from a departure.
 */
export async function recordCallEnded(
  db: DbLike,
  actor: CallFactActor & { callId: string },
  source: CallFactSource,
): Promise<void> {
  const current = await activeCall(db, actor.roomId);
  // A stale event names a superseded generation; it must not end the call that
  // replaced it.
  if (!current || current.callId !== actor.callId) return;

  await writeFacts(actor, [callEnded(actor, actor.callId, source)]);
}

function callStarted(
  actor: CallFactActor,
  callId: string,
  source: CallFactSource,
): Event {
  return build<"space.roomy.voice.callStarted.v0">({
    $type: "space.roomy.voice.callStarted.v0",
    room: actor.roomId,
    callId,
    source,
  });
}

function callEnded(
  actor: CallFactActor,
  callId: string,
  source: CallFactSource,
): Event {
  return build<"space.roomy.voice.callEnded.v0">({
    $type: "space.roomy.voice.callEnded.v0",
    room: actor.roomId,
    callId,
    source,
  });
}

/**
 * Validate an event against the SDK's own schema before it is written.
 *
 * `sendEvents` accepts raw payloads and validates them itself, but a fact
 * built here is synthesized rather than received, so a malformed one would
 * surface as a 400 at the write rather than at the call site that got it
 * wrong. Parsing here makes that a programming error with the event in hand.
 */
function build<T extends string>(
  event: { $type: T; [key: string]: unknown },
): Event {
  const parsed = parseEvent({ id: newUlid(), ...event });
  if (!parsed.success) {
    throw new Error(`Invalid ${event.$type} fact: ${parsed.error}`);
  }
  return parsed.data;
}

async function writeFacts(
  actor: CallFactActor,
  events: Event[],
): Promise<void> {
  if (events.length === 0) return;
  await getStreamManager().sendEvents(
    StreamDid.assert(actor.spaceId),
    events,
    actor.did,
  );
}
