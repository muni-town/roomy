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

import { Database } from "bun:sqlite";
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
  db?: Database;
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

  // Stage 1: personal stream must be caught up before we can read its
  // comp_space rows. Failures here are fatal — without it we have nothing
  // to scope by.
  //
  // `backfillDone` resolves when the SDK has *delivered* backfill events to
  // our callback; the actual SQL writes happen asynchronously via the
  // SpaceMaterializer's serial chain. We have to `drain()` as well to
  // guarantee the writes are visible — without it, the first request after
  // a fresh subscription often races and returns stale (empty) results.
  const personalMat = await getOrCreateMaterializer(
    personalStreamDid,
    opts.materializerOpts,
  );
  await personalMat.backfillDone;
  await personalMat.drain();

  const intendedSpaceDids = readIntendedSpaceDids(db, personalStreamDid);

  // Stage 2: each intended space, in parallel. Failures recorded, not thrown.
  const hydrationFailures: HydrationFailure[] = [];
  await Promise.all(
    intendedSpaceDids.map(async (spaceDid) => {
      try {
        const mat = await getOrCreateMaterializer(
          spaceDid,
          opts.materializerOpts,
        );
        await mat.backfillDone;
        await mat.drain();
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
function readIntendedSpaceDids(
  db: Database,
  personalStreamDid: StreamDid,
): StreamDid[] {
  const rows = db
    .query<{ id: string }, [string, string]>(
      `select tail as id
         from edges
        where head = ?
          and label = ?`,
    )
    .all(personalStreamDid, JOINED_SPACE_LABEL);
  return rows.map((r) => r.id as StreamDid);
}

/** Test helper. */
export function _resetHydrationInflight(): void {
  inflight.clear();
}
