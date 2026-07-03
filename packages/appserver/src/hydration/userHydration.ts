/**
 * Per-request membership hydration.
 *
 * Before a caller-scoped read can be answered, we need:
 *   1. The caller's personal stream materialised + caught up to backfill.
 *   2. Each non-left space referenced in that personal stream materialised
 *      + caught up.
 *
 * Once subscribed, materialisers stay live; the second call for the same
 * caller short-circuits on cached materializer + cached personal stream DID.
 *
 * Per-user dedup: concurrent calls for the same userDid share an in-flight
 * promise to avoid N parallel personal-stream reads.
 */

import type { DbLike } from "../db/types.ts";
import { type StreamDid, type UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import {
  getOrCreateMaterializer,
  type GetOrCreateOpts,
} from "../materialization/registry.ts";
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
  /** Override registry options (tests). Forwarded to every getOrCreateMaterializer call. */
  materializerOpts?: GetOrCreateOpts;
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

  // Stage 1: start materialising the personal stream. We intentionally
  // do NOT await backfillDone here — doing so blocks the request handler
  // until every historical event is applied, which can exceed Bun's
  // idleTimeout on large spaces. Instead we read whatever state is currently
  // materialised and return it. If backfill is still in progress the
  // returned membership may be partial; the client will see a complete
  // view once the materializer finishes and invalidation signals arrive.
  const personalMat = await getOrCreateMaterializer(
    personalStreamDid,
    opts.materializerOpts,
  );
  // If the materializer already completed backfill, drain to ensure writes
  // are visible. If not, we serve whatever is on disk — worst case the user
  // sees an empty list that fills in over the next few seconds.
  if (personalMat.backfillSettled) {
    if (personalMat.backfillError) {
      throw new Error(
        `Personal stream backfill failed for ${personalStreamDid}`,
      );
    }
    await personalMat.drain();
  }

  const intendedSpaceDids = await readIntendedSpaceDids(db, personalStreamDid);

  // Stage 2: each intended space, in parallel. Failures recorded, not thrown.
  const hydrationFailures: HydrationFailure[] = [];
  await Promise.all(
    intendedSpaceDids.map(async (spaceDid) => {
      try {
        const mat = await getOrCreateMaterializer(
          spaceDid,
          opts.materializerOpts,
        );
        // Same non-blocking strategy as Stage 1: if backfill is already
        // done, drain so reads see the latest writes. Otherwise proceed
        // with whatever is on disk.
        if (mat.backfillSettled) {
          if (mat.backfillError) {
            throw new Error(`Space backfill failed for ${spaceDid}`);
          }
          await mat.drain();
        }
      } catch (err) {
        hydrationFailures.push({
          streamDid: spaceDid,
          reason: err instanceof Error ? err.message : String(err),
        });
        console.warn(
          `[hydration] ${userDid} failed to hydrate space ${spaceDid}:`,
          err,
        );
      }
    }),
  );

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
