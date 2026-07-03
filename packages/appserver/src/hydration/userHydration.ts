/**
 * Per-request membership hydration.
 *
 * Before a caller-scoped read can be answered, we need:
 *   1. The caller's personal stream resolved (cached or created).
 *   2. Each non-left space referenced in that personal stream identified.
 *
 * Materialization is handled inline by StreamManager when events are written,
 * so hydration only needs to resolve the personal stream and read the
 * intended spaces from the materialized DB.
 *
 * Per-user dedup: concurrent calls for the same userDid share an in-flight
 * promise to avoid N parallel personal-stream reads.
 */

import type { DbLike } from "../db/types.ts";
import { type StreamDid, type UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { JOINED_SPACE_LABEL } from "../queries/joinedSpaces.ts";
import {
  PersonalStreamRecordNotFound,
  resolvePersonalStreamDid,
  type ResolveOpts,
} from "./resolvePersonalStream.ts";

export interface HydrationFailure {
  streamDid: StreamDid;
  reason: string;
}

export interface UserHydrationResult {
  /** Caller's personal stream DID. Null if they have no record on their PDS. */
  personalStreamDid: StreamDid | null;
  /** Space DIDs the user has personal.joinSpace'd and not personal.leaveSpace'd. */
  intendedSpaceDids: StreamDid[];
  /** Spaces that failed to materialise (network, leaf unreachable, etc.). Logged, not thrown. */
  hydrationFailures: HydrationFailure[];
}

export interface HydrateOpts extends ResolveOpts {
  db?: DbLike;
}

const inflight = new Map<UserDid, Promise<UserHydrationResult>>();

export function hydrateUserMembership(
  userDid: UserDid,
  opts: HydrateOpts = {},
): Promise<UserHydrationResult> {
  const existing = inflight.get(userDid);
  if (existing) return existing;

  const promise = run(userDid, opts).finally(() => {
    inflight.delete(userDid);
  });
  inflight.set(userDid, promise);
  return promise;
}

async function run(
  userDid: UserDid,
  opts: HydrateOpts,
): Promise<UserHydrationResult> {
  const db = opts.db ?? openDb();

  let personalStreamDid: StreamDid;
  try {
    personalStreamDid = await resolvePersonalStreamDid(db, userDid, opts);
  } catch (err) {
    if (err instanceof PersonalStreamRecordNotFound) {
      // First-login users may not have a personal stream yet. Treat as
      // "joined no spaces". The frontend will create the record on first
      // interaction.
      return {
        personalStreamDid: null,
        intendedSpaceDids: [],
        hydrationFailures: [],
      };
    }
    throw err;
  }

  // Materialization is handled by the subscription system. We read whatever
  // state is currently materialised and return it. If backfill is still in
  // progress the returned membership may be partial; the client will see a
  // complete view once the materializer finishes and invalidation signals
  // arrive.
  const intendedSpaceDids = await readIntendedSpaceDids(db, personalStreamDid);

  const hydrationFailures: HydrationFailure[] = [];


  return { personalStreamDid, intendedSpaceDids, hydrationFailures };
}

/**
 * Read the user's intended (joined-and-not-left) spaces from their personal
 * stream's materialised state. `PersonalJoinSpace` writes a `joinedSpace`
 * edge (head = personal stream, tail = space); `PersonalLeaveSpace` deletes
 * it. Membership is per-user, so it lives in `edges` rather than on the
 * single global `comp_space` row a space has.
 */
async function readIntendedSpaceDids(
  db: DbLike,
  personalStreamDid: StreamDid,
): Promise<StreamDid[]> {
  const rows = await db
    .query(
      `select tail as id
         from edges
        where head = ?
          and label = ?`,
    )
    .all<{ id: string }>([personalStreamDid, JOINED_SPACE_LABEL]);
  return rows.map((r) => r.id as StreamDid);
}

/** Test helper. */
export function _resetHydrationInflight(): void {
  inflight.clear();
}
