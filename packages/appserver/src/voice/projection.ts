/**
 * Reads over the voice projections.
 *
 * `active_calls` / `call_participants` (per-space) and `voice_projected_calls`
 * (global) are maintained by the `space.roomy.voice.*` materialisers. Every
 * read here tolerates the tables being absent: an appserver that has never
 * served a call, or a per-space DB mid-rebuild, must read as "no call" rather
 * than fail the surrounding query.
 */

import { StreamDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { openGlobalDb } from "../db/db.ts";

export interface ActiveCall {
  roomId: string;
  callId: string;
  /** Canonical call start, ms since epoch. */
  startedAt: number;
  source: string;
}

export interface CallParticipant {
  did: string;
  callId: string;
  joinedAt: number;
  source: string;
}

/** The room's active call, or null. */
export async function activeCall(
  db: DbLike,
  roomId: string,
): Promise<ActiveCall | null> {
  try {
    const row = await db
      .query(
        `select room_id, call_id, started_at, source
           from active_calls
          where room_id = ?`,
      )
      .get<{
        room_id: string;
        call_id: string;
        started_at: number;
        source: string;
      }>(roomId);
    if (!row) return null;
    return {
      roomId: row.room_id,
      callId: row.call_id,
      startedAt: row.started_at,
      source: row.source,
    };
  } catch {
    return null;
  }
}

/** The participant DIDs of one call generation, empty when there are none. */
export async function participantsIn(
  db: DbLike,
  roomId: string,
  callId: string,
): Promise<Set<string>> {
  try {
    const rows = await db
      .query(
        `select did from call_participants
          where room_id = ? and call_id = ?`,
      )
      .all<{ did: string }>(roomId, callId);
    return new Set(rows.map((r) => r.did));
  } catch {
    return new Set();
  }
}

/** The room's participants, with the facts the UI renders. */
export async function listParticipants(
  db: DbLike,
  roomId: string,
): Promise<CallParticipant[]> {
  try {
    const rows = await db
      .query(
        `select did, call_id, joined_at, source
           from call_participants
          where room_id = ?
          order by joined_at asc`,
      )
      .all<{
        did: string;
        call_id: string;
        joined_at: number;
        source: string;
      }>(roomId);
    return rows.map((r) => ({
      did: r.did,
      callId: r.call_id,
      joinedAt: r.joined_at,
      source: r.source,
    }));
  } catch {
    return [];
  }
}

/**
 * The space's active calls, with participant counts, for the sidebar.
 *
 * An empty list when the space is not materialised or the projection is
 * unavailable — the caller renders no call affordances rather than erroring.
 */
export async function listActiveCalls(
  db: DbLike,
  spaceId: string,
): Promise<Array<ActiveCall & { participantCount: number }>> {
  try {
    const rows = await db
      .query(
        `select ac.room_id as room_id,
                ac.call_id as call_id,
                ac.started_at as started_at,
                ac.source as source,
                (select count(*) from call_participants cp
                  where cp.room_id = ac.room_id and cp.call_id = ac.call_id)
                  as participant_count
           from active_calls ac
           join entities e on e.id = ac.room_id
          where e.stream_id = ?`,
      )
      .all<{
        room_id: string;
        call_id: string;
        started_at: number;
        source: string;
        participant_count: number;
      }>(spaceId);
    return rows.map((r) => ({
      roomId: r.room_id,
      callId: r.call_id,
      startedAt: r.started_at,
      source: r.source,
      participantCount: r.participant_count,
    }));
  } catch {
    return [];
  }
}

/** A call the reconciler still believes is live, with its owning space. */
export interface ProjectedCall {
  roomId: string;
  spaceId: StreamDid;
  callId: string;
  startedAt: number;
}

/**
 * Every call the reconciler must verify, from the global index.
 *
 * This is one table rather than a fan-out over per-space DBs: the reconciler
 * runs every 30 s against whatever a deployment's total call count is, and
 * opening each space's DB to enumerate them would make the pass's cost scale
 * with the number of spaces instead.
 */
export async function listProjectedCalls(): Promise<ProjectedCall[]> {
  try {
    const rows = await openGlobalDb()
      .query(
        `select room_id, space_id, call_id, started_at
           from voice_projected_calls`,
      )
      .all<{
        room_id: string;
        space_id: string;
        call_id: string;
        started_at: number;
      }>();
    return rows.map((r) => ({
      roomId: r.room_id,
      spaceId: StreamDid.assert(r.space_id),
      callId: r.call_id,
      startedAt: r.started_at,
    }));
  } catch {
    return [];
  }
}
