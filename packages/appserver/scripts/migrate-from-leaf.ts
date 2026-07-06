/**
 * One-time migration script: copies events from Leaf per-stream SQLite databases
 * into the appserver's events database, copies DID keys from Leaf's main DB,
 * then bumps SCHEMA_VERSION to trigger full re-materialization from the local
 * event log on next boot.
 *
 * Usage: bun run scripts/migrate-from-leaf.ts [--dry-run]
 *
 * Environment variables:
 *   LEAF_DATA_DIR   — path to Leaf's data/streams directory (default: data/streams)
 *   LEAF_MAIN_DB    — path to Leaf's main database (default: <parent of LEAF_DATA_DIR>/leaf.db)
 *   EVENTS_DB_PATH  — path to appserver events DB (default: data/roomy-events.sqlite)
 *   APPSERVER_DB_PATH — path to appserver main DB (default: data/roomy.sqlite)
 */

import { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface LeafEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
  signature: Uint8Array;
}

export async function migrateStream(
  eventsDb: Database,
  mainDb: Database,
  streamDid: string,
  leafDbPath: string,
  dryRun: boolean,
): Promise<{ eventsMigrated: number; latestIdx: number }> {
  const leafDb = new Database(leafDbPath);

  const events = leafDb
    .query(
      `
      SELECT idx, user, payload, signature
      FROM events
      ORDER BY idx
    `,
    )
    .all() as LeafEvent[];

  if (events.length === 0) {
    leafDb.close();
    return { eventsMigrated: 0, latestIdx: 0 };
  }

  const latestIdx = events[events.length - 1].idx;

  if (!dryRun) {
    const insert = eventsDb.prepare(`
      INSERT OR IGNORE INTO stream_events (stream_id, idx, user, payload, signature)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = eventsDb.transaction(() => {
      for (const event of events) {
        insert.run(streamDid, event.idx, event.user, event.payload, event.signature);
      }
    });
    tx();

    eventsDb.run(
      `
      INSERT INTO stream_state (stream_id, latest_event)
      VALUES (?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET latest_event = excluded.latest_event
    `,
      [streamDid, latestIdx],
    );

    mainDb.run(
      `
      UPDATE comp_space SET backfilled_to = ? WHERE entity = ?
    `,
      [latestIdx, streamDid],
    );
  }

  leafDb.close();
  return { eventsMigrated: events.length, latestIdx };
}

export async function migrateDidKeys(
  eventsDb: Database,
  leafMainDbPath: string,
  dryRun: boolean,
): Promise<void> {
  if (!existsSync(leafMainDbPath)) {
    console.log(`\n[DID KEYS] Leaf main DB not found at ${leafMainDbPath} — skipping DID key migration`);
    return;
  }

  const leafDb = new Database(leafMainDbPath, { readonly: true });

  const didRows = leafDb.query("select did from dids").all() as { did: string }[];

  if (dryRun) {
    console.log(`\n[DID KEYS] Would migrate ${didRows.length} DIDs from ${leafMainDbPath}`);
  } else {
    let keyCount = 0;
    let ownerCount = 0;

    for (const { did } of didRows) {
      eventsDb.run("insert or ignore into dids (did) values (?)", did);

      const keyRow = leafDb
        .query("select p256_key, k256_key from did_keys where did = ?")
        .get(did) as { p256_key: Uint8Array | null; k256_key: Uint8Array | null } | undefined;
      if (keyRow) {
        eventsDb.run(
          "insert or ignore into did_keys (did, p256_key, k256_key) values (?, ?, ?)",
          did,
          keyRow.p256_key,
          keyRow.k256_key,
        );
        keyCount++;
      }

      const ownerRows = leafDb
        .query("select owner from did_owners where did = ?")
        .all(did) as { owner: string }[];
      for (const { owner } of ownerRows) {
        eventsDb.run(
          "insert or ignore into did_owners (did, owner) values (?, ?)",
          did,
          owner,
        );
        ownerCount++;
      }
    }

    console.log(`Migrated ${keyCount} DID keys, ${ownerCount} owners`);
  }

  leafDb.close();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const leafDataDir = process.env.LEAF_DATA_DIR ?? "data/streams";
  const leafMainDb = process.env.LEAF_MAIN_DB ?? join(leafDataDir, "..", "leaf.db");
  const eventsDbPath = process.env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite";
  const mainDbPath = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";

  if (!existsSync(leafDataDir)) {
    console.error(`Leaf data directory not found: ${leafDataDir}`);
    console.error("Set LEAF_DATA_DIR to point at Leaf's data/streams directory");
    process.exit(1);
  }

  const streamDirs = readdirSync(leafDataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const eventsDb = new Database(eventsDbPath);
  const mainDb = new Database(mainDbPath);
  let totalEvents = 0;
  let totalStreams = 0;

  for (const dir of streamDirs) {
    const streamDbPath = join(leafDataDir, dir, "stream.db");
    if (!existsSync(streamDbPath)) continue;

    const result = await migrateStream(eventsDb, mainDb, dir, streamDbPath, dryRun);
    totalEvents += result.eventsMigrated;
    totalStreams++;

    console.log(
      `[${dryRun ? "DRY-RUN" : "MIGRATED"}] ${dir}: ${result.eventsMigrated} events (latest idx: ${result.latestIdx})`,
    );
  }

  console.log(`\nTotal: ${totalStreams} streams, ${totalEvents} events`);

  // ─── DID key migration ──────────────────────────────────────────────
  // Copy dids, did_keys, and did_owners from Leaf's main DB into the
  // events DB so per-stream signing keys are available for PLC operations.
  await migrateDidKeys(eventsDb, leafMainDb, dryRun);

  if (!dryRun) {
    mainDb.run(
      `
      INSERT INTO roomy_schema_version (id, version)
      VALUES (1, 'MIGRATION_PENDING')
      ON CONFLICT(id) DO UPDATE SET version = 'MIGRATION_PENDING'
    `,
    );
    console.log("Schema version set to MIGRATION_PENDING — re-materialization will happen on next boot");
  }

  eventsDb.close();
  mainDb.close();
}

if (import.meta.main) {
  main().catch(console.error);
}
