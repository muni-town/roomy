/**
 * Apply a single materialised event's SQL statements to the per-space DB.
 *
 * Each event runs inside its own SAVEPOINT so a single failing event rolls
 * back cleanly without poisoning the rest of the batch. This is stricter than
 * the frontend's per-statement error tolerance: the appserver treats partial
 * application as a bug, not a feature.
 *
 * Side-effects (sort_idx, unread counter) live here rather than inside the SDK
 * materialisers because the original design keeps materialisers free of
 * backfill awareness.
 *
 * Per-space split (Phase 3): `db` is the per-space DB — the source of truth.
 * There is no monolithic DB. `globalDb` (optional) receives the
 * `joinedSpace`/`leftSpace` membership edges and the `SetUserProfile` global
 * profile write. `readStateDb` (optional) receives the read-state side-effects
 * (read_positions, user_thread_activity, user_room_participation) — the
 * per-space DB has no readstate tables.
 *
 * Concurrency: `applyBundle` manages its SAVEPOINT via individual async
 * `db.exec` calls (each a separate worker message). Without serialization,
 * concurrent calls interleave: call A's `SAVEPOINT evt_AAA` starts an implicit
 * transaction, call B's `SAVEPOINT evt_BBB` nests within it, then call A's
 * `RELEASE evt_AAA` commits the transaction — destroying evt_BBB. When call B
 * tries `RELEASE evt_BBB`, SQLite raises "no such savepoint". The mutex below
 * serializes the savepoint-managed section so only one `applyBundle` has an
 * open savepoint at a time.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import type { SqlStatement, StatementBundleSuccess } from "./types.ts";
import {
  setMessageSortIdxByForward,
  setMessageSortIdxByReorder,
  setMessageSortIdxByTimestamp,
} from "./sortIdx.ts";
import { isThread, refreshThreadActivityOnMessage, upsertUserThreadActivity } from "../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../queries/userRoomParticipation.ts";
import { upsertActivityItem } from "./activityItem.ts";
import { writeSetUserProfileToGlobal } from "./profiles.ts";
import { isGlobalDbStatement } from "./statementRouting.ts";
import { decodeTime } from "ulidx";

const decodeTimeFromId = (id: string): number => decodeTime(id);

// ─── Async mutex ─────────────────────────────────────────────────────────

/**
 * Minimal promise-based mutex. Serializes the savepoint-managed section of
 * `applyBundle` so concurrent calls don't interleave their SAVEPOINT/RELEASE
 * operations (which would destroy each other's savepoints — see file header).
 */
class AsyncMutex {
  #chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const chain = this.#chain;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#chain = promise;
    await chain;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

/**
 * Per-space async mutexes for savepoint-managed SQL sections.
 *
 * Keyed by `streamId` so concurrent materialization on DIFFERENT spaces is
 * not serialized (they can reach their own pool workers in parallel), while
 * same-space sections (statement transactions + applyBundle's SAVEPOINT
 * section) never overlap — which would otherwise let a `db.transaction`
 * `BEGIN` nest inside an open SAVEPOINT and fail with "cannot start a
 * transaction within a transaction".
 */
const spaceMutexes = new Map<string, AsyncMutex>();

export function getSavepointMutex(streamId: string): AsyncMutex {
  let m = spaceMutexes.get(streamId);
  if (!m) {
    m = new AsyncMutex();
    spaceMutexes.set(streamId, m);
  }
  return m;
}

export interface ApplyBundleOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
  streamId: StreamDid;
}

export async function applyBundle(
  db: DbLike,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
  globalDb?: DbLike,
  readStateDb?: DbLike,
): Promise<void> {
  // Serialize the savepoint-managed section: manual SAVEPOINT/RELEASE via
  // individual async db.exec calls is not atomic. Without this lock,
  // concurrent calls destroy each other's savepoints (see file header).
  return getSavepointMutex(opts.streamId).run(() =>
    applyBundleInner(db, bundle, opts, globalDb, readStateDb),
  );
}

async function applyBundleInner(
  db: DbLike,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
  globalDb?: DbLike,
  readStateDb?: DbLike,
): Promise<void> {
  const savepoint = `evt_${bundle.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  await db.exec(`savepoint ${savepoint}`);

  // Per-batch cache: isThread result is stable per room, avoid re-querying
  // for every message in the same room within a batch.
  const isThreadCache = new Map<string, boolean>();
  const cachedIsThread = async (roomId: string): Promise<boolean> => {
    let result = isThreadCache.get(roomId);
    if (result === undefined) {
      result = await isThread(db, roomId);
      isThreadCache.set(roomId, result);
    }
    return result;
  };

  try {
    // ── Per-space DB (source of truth) ─────────────────────────────────
    // Statements + per-space side effects run on the per-space DB. Global
    // edge statements route to `globalDb`.
    for (const statement of bundle.statements) {
      await runStatementForTargets(db, globalDb, statement);
    }

    await setMessageSortIdxByTimestamp(db, bundle.event);
    await setMessageSortIdxByReorder(db, opts.streamId, bundle.event);
    await setMessageSortIdxByForward(db, bundle.event);

    // Activity feed: upsert the activity item for every createMessage event
    // (including backfill, so existing rooms get populated).
    if (
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      await upsertActivityItem(db, {
        roomId: bundle.event.room,
        spaceId: opts.streamId,
        messageId: bundle.event.id,
      });
    }

    // ── Read-state side effects (readStateDb only) ────────────────────
    // readstate.* tables do not exist in the per-space DB.

    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room &&
      readStateDb
    ) {
      const isThreadRoom = await cachedIsThread(bundle.event.room);

      // Increment unread for all users tracking this room.
      if (isThreadRoom) {
        // Threads: only bump users who have engaged with this thread.
        // Uses INSERT ... ON CONFLICT DO UPDATE so the read_positions row
        // is created if it doesn't exist yet (lazy creation). The space_did
        // and seen_up_to come from the per-space DB (opts.streamId is the
        // space DID; max sort_idx is read from the per-space entities).
        const maxSortRow = await db
          .query("select max(sort_idx) as m from entities where room = ?")
          .get<{ m: string | null }>(bundle.event.room);
        const seenUpTo = maxSortRow?.m ?? "0";
        await readStateDb.run(
          `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
           select uta.user_did, ?, ?, ?, 1, (unixepoch() * 1000)
             from user_thread_activity uta
            where uta.thread_id = ?
           on conflict(user_did, room_id) do update set
             unread_count = unread_count + 1,
             updated_at = (unixepoch() * 1000)`,
          bundle.event.room,
          opts.streamId,
          seenUpTo,
          bundle.event.room,
        );
      } else {
        // Channels: bump all users with a read_positions row.
        await readStateDb.run(
          `update read_positions
              set unread_count = unread_count + 1,
                  updated_at = (unixepoch() * 1000)
            where room_id = ?`,
          bundle.event.room,
        );
      }

      // Track thread activity: a message in a thread refreshes the activity
      // window for every user tracking the thread (re-surfacing it in their
      // sidebar when someone else posts) and registers the author.
      if (isThreadRoom) {
        const timestamp = decodeTimeFromId(bundle.event.id);
        await refreshThreadActivityOnMessage(readStateDb, bundle.event.room, bundle.user, opts.streamId, timestamp);
      }

      // Track the author's participation in this room (all room types —
      // channels included). The Engaged push-digest gate uses this to
      // restrict prompts to rooms you've spoken in. Uses the effective author
      // (override-author for bridged messages) to match the `author` edge.
      const ext = bundle.event.extensions?.[
        "space.roomy.extension.authorOverride.v0"
      ] as { did?: unknown } | undefined;
      const overrideDid =
        typeof ext?.did === "string" ? ext.did : undefined;
      await upsertUserRoomParticipation(
        readStateDb,
        overrideDid ?? bundle.user,
        bundle.event.room,
        decodeTimeFromId(bundle.event.id),
      );
    }

    // Track thread creation: if the event creates a thread, register the
    // creating user's activity so the thread appears in their sidebar
    // immediately, without needing to send a message first.
    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.room.createRoom.v0" &&
      "kind" in bundle.event &&
      bundle.event.kind === "space.roomy.thread" &&
      readStateDb
    ) {
      const timestamp = decodeTimeFromId(bundle.event.id);
      await upsertUserThreadActivity(readStateDb, bundle.user, bundle.event.id, opts.streamId, timestamp);
    }

    // Track reaction activity in threads (non-backfill only).
    if (
      !opts.isBackfill &&
      (bundle.event.$type === "space.roomy.reaction.addReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.addBridgedReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeBridgedReaction.v0") &&
      bundle.event.room &&
      readStateDb
    ) {
      if (await cachedIsThread(bundle.event.room)) {
        const timestamp = decodeTimeFromId(bundle.event.id);
        // For bridged reactions, use the reactingUser field instead of the
        // authenticated event sender.
        const reactingUser =
          "reactingUser" in bundle.event && typeof bundle.event.reactingUser === "string"
            ? bundle.event.reactingUser
            : bundle.user;
        await upsertUserThreadActivity(readStateDb, reactingUser, bundle.event.room, opts.streamId, timestamp);
      }
    }

    // SetUserProfile events update the global profile store (bridged users
    // don't go through HappyView, so the materialiser is the only writer).
    if (bundle.event.$type === "space.roomy.user.updateProfile.v0") {
      await writeSetUserProfileToGlobal(
        bundle.event as unknown as {
          did: string;
          name?: unknown;
          avatar?: unknown;
          description?: unknown;
          extensions?: Record<string, unknown>;
        },
      );
    }

    // Commit the per-space savepoint.
    await db.exec(`release ${savepoint}`);
  } catch (e) {
    // Per-space failure: roll back and rethrow — the event is lost.
    await db.exec(`rollback to ${savepoint}`);
    await db.exec(`release ${savepoint}`);
    throw e;
  }
}

/**
 * Run a statement against the derived DBs: global-edge statements go to the
 * global DB, everything else to the per-space DB. A missing target is a
 * silent no-op (tests that don't exercise the split pass no derived DBs).
 */
async function runStatementForTargets(
  db: DbLike,
  globalDb: DbLike | undefined,
  statement: SqlStatement,
): Promise<void> {
  if (isGlobalDbStatement(statement.sql)) {
    if (globalDb) await runStatement(globalDb, statement);
    return;
  }
  await runStatement(db, statement);
}

async function runStatement(db: DbLike, statement: SqlStatement): Promise<void> {
  const params = statement.params;
  if (params === undefined) {
    await db.run(statement.sql);
  } else if (Array.isArray(params)) {
    await db.run(statement.sql, ...(params as unknown[] as never[]));
  } else {
    await db.run(statement.sql, params as never);
  }
}
