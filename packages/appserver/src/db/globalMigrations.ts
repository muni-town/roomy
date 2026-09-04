import type { StreamDid } from "@roomy-space/sdk";
import type { DbLike } from "./types.ts";
import { log } from "../log.ts";

interface PendingMigration {
  version: string;
}

type GlobalMigrationTask = (
  db: DbLike,
  streamDids: StreamDid[],
) => Promise<void>;

/**
 * Async/data migrations keyed by the global schema version that scheduled
 * them. Structural DDL is applied synchronously by the DB worker; these tasks
 * may fan out across per-space DBs and therefore run from the main thread.
 */
const GLOBAL_MIGRATION_TASKS: Record<string, GlobalMigrationTask> = {
  "6": repairGlobalMembership,
  // v7: additive DDL only — the `search_backfill_cursor` table is created
  // by the schema exec; no data migration is needed. Kept registered so an
  // interrupted v7 upgrade still completes on the next boot.
  "7": noopMigration,
  // v8: `federation_receiver_permissions.kind` widened from
  // ('user','role') to ('members','user','role') — SQLite can't alter a
  // CHECK, so the table is rebuilt. Runs before per-stream replay, so
  // 'members' grants replayed from the event log insert cleanly.
  "8": rebuildReceiverPermissionsConstraint,
};


/**
 * v8: widen `federation_receiver_permissions.kind` to admit 'members'.
 *
 * The v7 table declared `check(kind in ('user','role'))`, which rejects the
 * members-wide receiver grant. SQLite can't ALTER a CHECK constraint, so
 * rebuild the table with the widened constraint, preserving every existing
 * row. Idempotent: a DB that already has the widened table (e.g. a fresh
 * v8 install, or a completed migration) is a no-op.
 */
async function rebuildReceiverPermissionsConstraint(
  db: DbLike,
  _streamDids: StreamDid[],
): Promise<void> {
  const globalDb = db.global?.();
  if (!globalDb) return;

  const current = await globalDb
    .query("select sql from sqlite_master where type = 'table' and name = 'federation_receiver_permissions'")
    .get<{ sql: string }>();
  // Fresh database on the current schema — nothing to rebuild.
  if (!current || current.sql.includes("'members'")) return;

  await globalDb.transaction([
    {
      type: "exec",
      sql: `alter table federation_receiver_permissions rename to federation_receiver_permissions_v7`,
    },
    {
      type: "exec",
      sql: `create table federation_receiver_permissions (
        space_id             text not null,   -- origin space A
        federating_space_did text not null,   -- receiving space B
        room_id              text not null,   -- channel id in A
        grantee              text not null,   -- B space DID / B user DID / B role id
        kind                 text not null check(kind in ('members','user','role')),
        permission           text not null check(permission in ('read','readwrite')),
        primary key (space_id, federating_space_did, room_id, grantee, kind)
      ) strict`,
    },
    {
      type: "exec",
      sql: `insert into federation_receiver_permissions
        select space_id, federating_space_did, room_id, grantee, kind, permission
          from federation_receiver_permissions_v7`,
    },
    {
      type: "exec",
      sql: `drop table federation_receiver_permissions_v7`,
    },
    {
      type: "exec",
      sql: `create index if not exists idx_frper_room on federation_receiver_permissions(room_id)`,
    },
  ]);
}
/** No-op for additive-DDL-only bumps (the table is created by the schema exec). */
async function noopMigration(): Promise<void> {}

/**
 * Run incomplete global post-migrations in version order.
 *
 * Completion is stamped only after a task succeeds in full. Tasks must be
 * idempotent: if the process exits midway, the null marker remains and the
 * whole task is retried on the next boot.
 */
export async function runPendingGlobalMigrations(
  db: DbLike,
  streamDids: StreamDid[],
): Promise<void> {
  const globalDb = db.global?.();
  if (!globalDb) return;

  const pending = await globalDb
    .query(
      `select version
         from global_schema_migrations
        where completed_at is null
        order by cast(version as integer)`,
    )
    .all<PendingMigration>();

  for (const { version } of pending) {
    const task = GLOBAL_MIGRATION_TASKS[version];
    if (!task) {
      throw new Error(`No global post-migration task registered for schema v${version}`);
    }

    log.info("startup", `running global post-migration v${version}`);
    await task(db, streamDids);
    await globalDb.run(
      `update global_schema_migrations
          set completed_at = ?
        where version = ? and completed_at is null`,
      Date.now(),
      version,
    );
    log.info("startup", `global post-migration v${version} complete`);
  }
}

/**
 * Reconstruct active joinedSpace edges from per-space membership truth.
 *
 * Admins who leave retain their admin edge, so only `member` is authoritative
 * for an active join. Inserts/deletes are idempotent and run per space.
 */
async function repairGlobalMembership(
  db: DbLike,
  streamDids: StreamDid[],
): Promise<void> {
  const globalDb = db.global?.();
  if (!globalDb) return;

  let activeMemberships = 0;
  const failures: string[] = [];

  for (const streamDid of streamDids) {
    try {
      const spaceDb = db.forSpace?.(streamDid);
      if (!spaceDb) continue;

      const members = await spaceDb
        .query(
          `select distinct tail as user_did
             from edges
            where head = ? and label = 'member'`,
        )
        .all<{ user_did: string }>(streamDid);
      if (members.length === 0) continue;

      await globalDb.transaction(
        members.flatMap(({ user_did }) => [
          {
            type: "run" as const,
            sql: "insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')",
            params: [user_did, streamDid],
          },
          {
            type: "run" as const,
            sql: "delete from edges where head = ? and tail = ? and label = 'leftSpace'",
            params: [user_did, streamDid],
          },
        ]),
      );
      activeMemberships += members.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${streamDid}: ${message}`);
      log.warn("startup", `membership repair failed for ${streamDid}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `global membership repair incomplete: ${failures.length}/${streamDids.length} spaces failed`,
    );
  }

  log.info(
    "startup",
    `global membership repair ensured ${activeMemberships} active joined-space edges`,
  );
}
