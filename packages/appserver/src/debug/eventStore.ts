/**
 * Debug event store — a separate SQLite database recording every Leaf event
 * delivered and every materialization result.
 *
 * Gated behind `APPSERVER_DEBUG_DB_PATH` env var. When set, every event
 * received from the subscription and every materializer output is recorded
 * here, purely for offline forensics (query with sqlite3 CLI).
 *
 * This DB is independent from the main `roomy.sqlite` — no schema versioning,
 * no wipe-on-mismatch, no production impact. Just append-only logging.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DecodedStreamEvent, StreamDid, StreamIndex } from "@roomy-space/sdk";
import type { StatementBundle } from "../materialization/types.ts";

const DEBUG_DB_PATH = process.env.APPSERVER_DEBUG_DB_PATH ?? "";

/** Singleton debug DB handle. Null when debug mode is off. */
let db: Database | null = null;

function openDebugDb(): Database | null {
  if (db) return db;
  if (!DEBUG_DB_PATH) return null;

  const path = dirname(DEBUG_DB_PATH);
  if (path && !existsSync(path)) mkdirSync(path, { recursive: true });

  db = new Database(DEBUG_DB_PATH, { create: true });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");

  db.exec(`
    create table if not exists raw_events (
      stream_did text not null,
      idx integer not null,
      user_did text not null,
      event_type text,
      event_id text,
      payload blob,
      decoded_json text,
      delivered_ms integer not null,
      is_backfill integer not null default 0,
      batch_id text,
      primary key (stream_did, idx)
    );

    create table if not exists batch_log (
      id integer primary key autoincrement,
      stream_did text not null,
      batch_id text not null,
      is_backfill integer not null default 0,
      event_count integer not null,
      first_idx integer,
      last_idx integer,
      gap_detected integer not null default 0,
      gap_start integer,
      gap_end integer,
      received_ms integer not null
    );

    create table if not exists materialization_log (
      stream_did text not null,
      idx integer not null,
      event_type text,
      event_id text,
      status text not null,
      error_message text,
      bundle_type text,
      bundle_sql_count integer,
      materialized_ms integer not null,
      primary key (stream_did, idx)
    );
  `);

  return db;
}

function ms(): number {
  return Date.now();
}

/** True if debug event store is active (env var set). */
export function isDebugEnabled(): boolean {
  return Boolean(DEBUG_DB_PATH);
}

// ── Hooks called from SpaceMaterializer / applyBatch ──────────────────────

export interface BatchDeliveryInfo {
  streamDid: StreamDid;
  batchId: string;
  isBackfill: boolean;
  events: DecodedStreamEvent[];
}

/**
 * Record the raw events as delivered by the subscription.
 * Called from `SpaceMaterializer.processBatch()` before `applyBatch`.
 */
export function recordBatchDelivery(info: BatchDeliveryInfo): void {
  const d = openDebugDb();
  if (!d) return;

  const now = ms();
  const firstIdx = info.events.length > 0 ? info.events[0]!.idx : null;
  const lastIdx = info.events.length > 0 ? info.events[info.events.length - 1]!.idx : null;

  // Insert each raw event
  const insertEvent = d.prepare(`
    insert or ignore into raw_events
      (stream_did, idx, user_did, event_type, event_id, payload, decoded_json,
       delivered_ms, is_backfill, batch_id)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBatch = d.prepare(`
    insert into batch_log
      (stream_did, batch_id, is_backfill, event_count, first_idx, last_idx,
       gap_detected, gap_start, gap_end, received_ms)
    values (?, ?, ?, ?, ?, ?, 0, null, null, ?)
  `);

  const txn = d.transaction(() => {
    for (const e of info.events) {
      insertEvent.run(
        info.streamDid,
        e.idx,
        e.user,
        e.event.$type,
        e.event.id,
        null,              // payload — we don't keep the raw CBOR here
        JSON.stringify(e.event),
        now,
        info.isBackfill ? 1 : 0,
        info.batchId,
      );
    }
    insertBatch.run(
      info.streamDid,
      info.batchId,
      info.isBackfill ? 1 : 0,
      info.events.length,
      firstIdx,
      lastIdx,
      now,
    );
  });

  txn();
}

export interface MaterializationResultInfo {
  streamDid: StreamDid;
  idx: StreamIndex;
  eventType: string;
  eventId: string;
  status: "applied" | "materializer_error" | "apply_error";
  errorMessage?: string;
  bundle?: StatementBundle | null;
}

/**
 * Record the result of materializing a single event.
 * Called from `applyBatch()` after each event is processed.
 */
export function recordMaterialization(info: MaterializationResultInfo): void {
  const d = openDebugDb();
  if (!d) return;

  d.run(
    `insert or replace into materialization_log
       (stream_did, idx, event_type, event_id, status, error_message,
        bundle_type, bundle_sql_count, materialized_ms)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      info.streamDid,
      info.idx,
      info.eventType,
      info.eventId,
      info.status,
      info.errorMessage ?? null,
      info.bundle && info.bundle.status === "success"
        ? info.bundle.event.$type
        : info.bundle && info.bundle.status === "error"
          ? "error"
          : null,
      info.bundle && info.bundle.status === "success"
        ? info.bundle.statements.length
        : null,
      ms(),
    ],
  );
}

export interface GapDetectedInfo {
  streamDid: StreamDid;
  gapStart: StreamIndex;
  gapEnd: StreamIndex;
  gapSize: number;
  isBackfill: boolean;
  /**
   * The first idx of the batch that triggered the gap detection.
   * Used to look up the batch row in raw_events (gapEnd may fall inside
   * the gap where no raw_events row exists).
   */
  batchMinIdx: StreamIndex;
}

/**
 * Record a delivery gap in the debug DB.
 */
export function recordDeliveryGap(info: GapDetectedInfo): void {
  const d = openDebugDb();
  if (!d) return;

  d.run(
    `update batch_log
        set gap_detected = 1, gap_start = ?, gap_end = ?
      where stream_did = ?
        and batch_id = (
          select batch_id from raw_events
          where stream_did = ? and idx = ?
          limit 1
        )`,
    [
      info.gapStart,
      info.gapEnd,
      info.streamDid,
      info.streamDid,
      info.batchMinIdx,
    ],
  );
}

/** Close the debug DB. For cleanup, not normally needed. */
export function closeDebugDb(): void {
  if (!db) return;
  db.close();
  db = null;
}