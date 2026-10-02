/**
 * Voice reconciler: the periodic correction pass over LiveKit.
 *
 * Webhooks are pushed without delivery guarantees, so the projection can drift
 * — a missed `participant_left` leaves a ghost participant, a missed
 * `room_finished` leaves a call the SFU has already torn down. This loop lists
 * LiveKit every 30 s and writes correction facts for the differences.
 *
 * Two rules keep it safe to run on every replica:
 *
 *   - One leader at a time, via the `voice_reconciler` lease in the global DB.
 *     Replicas that lose the race do nothing that tick; the lease expires, so a
 *     crashed holder cannot wedge the loop.
 *   - Failures count across replicas in the global DB and reset on any
 *     successful pass. Three consecutive list failures end every projected
 *     call, because a list that keeps failing says nothing about whether the
 *     calls it would have listed are alive — recovery is preferred over
 *     reporting calls that may be dead.
 *
 * Listing LiveKit is injected as {@link LiveKitRoomLister} so the whole loop is
 * testable without an SFU.
 */

import type { StreamDid } from "@roomy-space/sdk";

import type { DbLike } from "../db/types.ts";
import { openGlobalDb } from "../db/db.ts";
import { log } from "../log.ts";
import { liveKitRoomName } from "./tokens.ts";
import { getLiveKit } from "./livekit.ts";
import { listProjectedCalls, participantsIn, type ProjectedCall } from "./projection.ts";
import { recordCallEnded, recordJoin, recordLeave } from "./callFacts.ts";

/** The reconciler's interval: short enough that a missed webhook is corrected
 *  before a participant notices, long enough that the list call is not itself
 *  a load source. */
export const RECONCILE_INTERVAL_MS = 30_000;

/** Consecutive list failures that end every projected call. */
export const FAILURE_THRESHOLD = 3;

/** How long a lease is held before another replica may take it. Twice the
 *  interval, so a single slow pass does not lose leadership. */
export const LEASE_TTL_MS = RECONCILE_INTERVAL_MS * 2;

/** What one call looks like from LiveKit's side. */
export interface LiveKitRoomState {
  roomName: string;
  /** Participant identities, which is the DID for every Roomy token. */
  participantDids: string[];
}

/**
 * Lists LiveKit's rooms — the seam the reconciler is tested against.
 * Production passes a client that calls LiveKit's room-list API; tests pass a
 * fixture that can fail on demand.
 */
export interface LiveKitRoomLister {
  listRooms(): Promise<LiveKitRoomState[]>;
}

// ─── Lease ────────────────────────────────────────────────────────────────

/**
 * Try to take the reconciler lease. Returns true when this caller holds it.
 * The compare-and-set is a single conditional upsert, so two replicas racing
 * produce one winner without a lock: the loser's `where` clause fails and it
 * writes nothing.
 *
 * The current holder always succeeds, which is what renews the lease. Without
 * that, a lone replica would take the lease on one tick, find it unexpired on
 * the next, and skip every other pass — the interval would silently become
 * twice what it claims to be.
 */
export async function acquireReconcilerLease(
  holder: string,
  now = Date.now(),
): Promise<boolean> {
  const globalDb = openGlobalDb();
  const expiresAt = now + LEASE_TTL_MS;
  try {
    const result = await globalDb.run(
      `insert into voice_reconciler_lease (name, holder, expires_at, updated_at)
       values ('voice_reconciler', ?, ?, ?)
       on conflict (name) do update set
         holder = excluded.holder,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       where voice_reconciler_lease.holder = excluded.holder
          or voice_reconciler_lease.expires_at <= ?`,
      holder,
      expiresAt,
      now,
      now,
    );
    return result.changes > 0;
  } catch (err) {
    log.error(
      `[voice] lease acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Consecutive list failures, from the shared counter. */
export async function consecutiveFailures(): Promise<number> {
  try {
    const row = await openGlobalDb()
      .query(`select consecutive from voice_reconciler_failures where id = 1`)
      .get<{ consecutive: number }>();
    return row?.consecutive ?? 0;
  } catch {
    return 0;
  }
}

/** Record a failed listing pass and return the new consecutive count. */
async function recordFailure(now = Date.now()): Promise<number> {
  try {
    const row = await openGlobalDb()
      .query(
        `insert into voice_reconciler_failures (id, consecutive, last_failure_at)
         values (1, 1, ?)
         on conflict (id) do update set
           consecutive = voice_reconciler_failures.consecutive + 1,
           last_failure_at = excluded.last_failure_at
         returning consecutive`,
      )
      .get<{ consecutive: number }>(now);
    return row?.consecutive ?? 1;
  } catch (err) {
    log.error(
      `[voice] failure counter update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/** Clear the failure counter — any successful pass resets the streak. */
async function clearFailures(): Promise<void> {
  try {
    await openGlobalDb().run(`delete from voice_reconciler_failures where id = 1`);
  } catch (err) {
    log.error(
      `[voice] failure counter reset failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Reconciliation ───────────────────────────────────────────────────────

export interface ReconcileDeps {
  /** Per-space DB resolver, so a call's own projection can be read. */
  openSpaceDb(spaceId: string): DbLike;
  /** Identity written on correction facts. The webhook path uses the
   *  appserver's own DID; the loop has no caller of its own. */
  serviceDid: string;
  holder: string;
  now?: number;
}

export interface ReconcileResult {
  /** False when another replica held the lease, so nothing was listed. */
  ran: boolean;
  endedCalls: number;
  joined: number;
  left: number;
  failures: number;
}

/**
 * One reconciliation pass.
 *
 * A listing failure never ends a call below the threshold, and never blocks
 * anything else — the next tick retries. At the threshold every projected call
 * is ended.
 */
export async function reconcileOnce(
  lister: LiveKitRoomLister,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const started = deps.now ?? Date.now();
  if (!(await acquireReconcilerLease(deps.holder, started))) {
    return { ran: false, endedCalls: 0, joined: 0, left: 0, failures: await consecutiveFailures() };
  }

  const projected = await listProjectedCalls();
  if (projected.length === 0) {
    // Nothing to verify: a listing call would cost a network round-trip to
    // confirm an empty projection. Recording a success here would also reset a
    // failure streak that the calls (had there been any) still needed.
    return { ran: true, endedCalls: 0, joined: 0, left: 0, failures: await consecutiveFailures() };
  }

  let rooms: LiveKitRoomState[];
  try {
    rooms = await lister.listRooms();
  } catch (err) {
    const failures = await recordFailure(started);
    log.error(
      `[voice] reconciliation list failed (${failures}/${FAILURE_THRESHOLD}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (failures >= FAILURE_THRESHOLD) {
      const ended = await endAllProjected(projected, deps, "reconciliation");
      await clearFailures();
      return { ran: true, endedCalls: ended, joined: 0, left: 0, failures: 0 };
    }
    return { ran: true, endedCalls: 0, joined: 0, left: 0, failures };
  }

  await clearFailures();

  const config = getLiveKit();
  const byRoomName = new Map(rooms.map((r) => [r.roomName, r]));
  let endedCalls = 0;
  let joined = 0;
  let left = 0;

  for (const call of projected) {
    const roomName = config
      ? liveKitRoomName(config, call.spaceId, call.roomId, call.callId)
      : call.roomId;
    const room = byRoomName.get(roomName);

    // Missing room ends the call immediately after a successful listing: the
    // SFU has no such room, so there is nothing to correct towards.
    if (!room) {
      const spaceDb = deps.openSpaceDb(call.spaceId);
      await recordCallEnded(
        spaceDb,
        {
          roomId: call.roomId,
          callId: call.callId,
          did: deps.serviceDid,
          spaceId: call.spaceId,
        },
        "reconciliation",
      );
      endedCalls++;
      continue;
    }

    const spaceDb = deps.openSpaceDb(call.spaceId);
    const actual = new Set(room.participantDids);
    const projectedDids = await participantsIn(spaceDb, call.roomId, call.callId);

    for (const did of actual) {
      if (projectedDids.has(did)) continue;
      await recordJoin(
        spaceDb,
        { did, spaceId: call.spaceId, roomId: call.roomId },
        "reconciliation",
      );
      joined++;
    }
    for (const did of projectedDids) {
      if (actual.has(did)) continue;
      await recordLeave(
        spaceDb,
        { did, spaceId: call.spaceId, roomId: call.roomId },
        "reconciliation",
      );
      left++;
    }

    // An empty LiveKit room after a successful listing means the call is over
    // even though no participant_left arrived for the last leaver.
    if (room.participantDids.length === 0) {
      await recordCallEnded(
        spaceDb,
        {
          roomId: call.roomId,
          callId: call.callId,
          did: deps.serviceDid,
          spaceId: call.spaceId,
        },
        "reconciliation",
      );
      endedCalls++;
    }
  }

  return { ran: true, endedCalls, joined, left, failures: 0 };
}

/** End every projected call — the three-failure escape hatch. */
async function endAllProjected(
  projected: readonly ProjectedCall[],
  deps: ReconcileDeps,
  reason: "reconciliation",
): Promise<number> {
  let ended = 0;
  for (const call of projected) {
    await recordCallEnded(
      deps.openSpaceDb(call.spaceId),
      {
        roomId: call.roomId,
        callId: call.callId,
        did: deps.serviceDid,
        spaceId: call.spaceId,
      },
      reason,
    );
    ended++;
  }
  return ended;
}

/**
 * The reconciler's periodic loop. Returns a stop function.
 *
 * A replica that never holds the lease still ticks: leadership is per-pass, so
 * a stopped leader is replaced by whichever replica acquires next.
 */
export function startVoiceReconciler(deps: ReconcileDeps & { lister: LiveKitRoomLister }): () => void {
  if (!getLiveKit()) {
    // Unconfigured LiveKit means no rooms, so reconciliation would end every
    // projected call on its first pass. The projections are already empty in
    // that state; running at all would only be a way to be wrong later.
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await reconcileOnce(deps.lister, deps);
    } catch (err) {
      log.error(
        `[voice] reconciliation pass threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  timer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

