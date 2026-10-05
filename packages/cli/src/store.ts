/**
 * Filesystem-backed message store for the CLI, implementing the SDK's cache
 * persistence seam (`CachePersister`, see `packages/sdk/src/cache/persister.ts`)
 * over `node:fs/promises`.
 *
 * Layout: one directory per space, one file per room, one persisted entry per
 * message row keyed by message id. A room file holds the room's rows in
 * timeline order — oldest → newest — so the file's order and the server's are
 * the same list.
 *
 * The seam's four rules, as they bind this adaptor:
 *
 *   1. Never throws into the caller. An absent directory, a permission error, a
 *      torn file, a snapshot of another shape — each is a diagnostic and
 *      resolves to "not cached". A caller with an unreadable store refetches;
 *      it never reads a wrong row.
 *   2. Versioned. Files carry `persistedShapeVersion(CACHE_BUILD_ID)`; a file
 *      written under a different version is discarded whole.
 *   3. Account-scoped. The snapshot carries the DID it was written for; a file
 *      written for another account is discarded.
 *   4. Bounded. At most `maxRowsPerRoom` rows per room are kept, newest by
 *      message time first — the least-recently-written rule the SDK's entry
 *      budget uses.
 *
 * Writes are atomic: a snapshot goes to a temp file in the same directory and
 * is renamed over the room file, so a process killed mid-write leaves either
 * the old file or the new one, never a torn one. Leftover temp files (a kill
 * between write and rename) are swept on the next save.
 *
 * ## The completeness flag
 *
 * A room file also records whether its rows reach the *oldest* message of the
 * room. A stored tail is only worth trusting as "the whole history" when it
 * does: rows fetched under `--limit 20` are the newest twenty, and their newest
 * message is the room's newest, so without the flag a later uncapped run would
 * read the twenty as the room's entire history. The flag lives beside the
 * snapshot's entries — the adaptor owns its own bytes — and an absent or
 * unreadable flag reads as *incomplete*, which costs a fetch and cannot produce
 * a wrong view.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { cache } from "@roomy-space/sdk";
import type {
  CachePersister,
  Diagnostic,
  PersistedEntry,
  SnapshotPolicy,
} from "@roomy-space/sdk";
import type { MessageInfo } from "./messages.js";

/** The query a room's rows belong to; the NSID the server pages them under. */
const ROOM_NSID = "space.roomy.room.getMessages" as const;

/**
 * Persisted-shape identity. Bump this whenever the shape of a persisted row
 * (`MessageInfo`) changes: a file written by an older build is then discarded
 * instead of being read as if it still meant what it meant.
 */
export const CACHE_BUILD_ID = "roomy-cli";

/** Rows kept per room before the oldest are dropped. */
export const DEFAULT_MAX_ROWS_PER_ROOM = 10_000;

const TEMP_PREFIX = ".tmp-";

/** The directory holding one space's room files. */
export function spaceDir(cacheDir: string, spaceId: string): string {
  return path.join(cacheDir, encodeURIComponent(spaceId));
}

/** The file a room's rows live in, under its space directory. */
export function roomFileName(roomId: string): string {
  // The `.json` suffix is what makes the name safe whatever the id carries:
  // even an id of ".." becomes the ordinary file "..json" in the space dir.
  return `${encodeURIComponent(roomId)}.json`;
}

/** One room's stored rows, and whether they reach the room's oldest message. */
export interface StoredRoom {
  rows: MessageInfo[];
  complete: boolean;
}

const EMPTY_ROOM: StoredRoom = { rows: [], complete: false };

export interface FileStoreOptions {
  /** The space directory, as returned by {@link spaceDir}. */
  dir: string;
  /** DID the cache belongs to; snapshots written for another DID are dropped. */
  account: string;
  /** Rows kept per room. Defaults to {@link DEFAULT_MAX_ROWS_PER_ROOM}. */
  maxRowsPerRoom?: number;
  onDiagnostic?: Diagnostic;
}

/** A room file: a persisted snapshot plus the adaptor's completeness flag. */
interface RoomFile {
  complete?: unknown;
}

/**
 * One space's rows on disk. {@link loadRoom}/{@link saveRoom} are the
 * room-scoped API the exporter uses; {@link load}/{@link save} implement the
 * seam on top of them, so both address the same files one way.
 */
export class FileStore implements CachePersister {
  readonly #dir: string;
  readonly #policy: SnapshotPolicy;
  readonly #maxRows: number;
  readonly #diag: Diagnostic | undefined;

  constructor(opts: FileStoreOptions) {
    this.#dir = opts.dir;
    this.#policy = {
      version: cache.persistedShapeVersion(CACHE_BUILD_ID),
      account: opts.account,
      onDiagnostic: opts.onDiagnostic,
    };
    this.#maxRows = opts.maxRowsPerRoom ?? DEFAULT_MAX_ROWS_PER_ROOM;
    this.#diag = opts.onDiagnostic;
  }

  /** One room's rows, and whether they reach that room's oldest message. */
  async loadRoom(roomId: string): Promise<StoredRoom> {
    const file = path.join(this.#dir, roomFileName(roomId));
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      // Absent, unreadable, or torn (not JSON): this room is not cached.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.#diag?.(`cache: discarding unreadable room file ${roomId}`, err);
      }
      return EMPTY_ROOM;
    }

    const rows = cache
      .readSnapshot(raw, this.#policy)
      .map(asMessage)
      .filter((row): row is MessageInfo => row !== undefined);
    const complete = (raw as RoomFile | null)?.complete === true;
    return { rows, complete };
  }

  /**
   * Replace one room's rows. Rows that survive the per-room budget are kept in
   * timeline order; `complete` records whether they reach the oldest message —
   * a room trimmed to the budget no longer does, so trimming clears it.
   */
  async saveRoom(
    roomId: string,
    rows: readonly MessageInfo[],
    complete: boolean,
  ): Promise<void> {
    try {
      await fs.mkdir(this.#dir, { recursive: true });
    } catch (err) {
      this.#diag?.(`cache: cannot create ${this.#dir}`, err);
      return;
    }
    const all = rowsToEntries(roomId, rows);
    const bounded = this.#bound(all);
    const snapshot = cache.writeSnapshot(bounded, this.#policy);
    const name = roomFileName(roomId);
    const tmp = path.join(
      this.#dir,
      `${TEMP_PREFIX}${name}-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({
          ...snapshot,
          complete: complete && bounded.length === all.length,
        }),
      );
      await fs.rename(tmp, path.join(this.#dir, name));
    } catch (err) {
      // The room file keeps its previous contents, which is a valid, older
      // view of the room rather than a broken one.
      this.#diag?.(`cache: writing room ${roomId} failed`, err);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Remove one room's file. */
  async forgetRoom(roomId: string): Promise<void> {
    try {
      await fs.rm(path.join(this.#dir, roomFileName(roomId)), { force: true });
    } catch (err) {
      this.#diag?.(`cache: removing room ${roomId} failed`, err);
    }
  }

  /** Every persisted row of this space, across every room. */
  async load(): Promise<PersistedEntry[]> {
    const out: PersistedEntry[] = [];
    for (const roomId of await this.#rooms()) {
      const { rows } = await this.loadRoom(roomId);
      out.push(...rowsToEntries(roomId, rows));
    }
    return out;
  }

  /**
   * Replace the space's persisted set: each named room is written whole, and a
   * room file the set does not name is removed.
   *
   * Every room is left *incomplete*. A persisted set is whatever the caller's
   * cache happened to hold — for a paginated query that is the pages it
   * mounted, not the room's history — so this path can never claim a room's
   * rows reach its oldest message. Only {@link saveRoom} does, and only on the
   * caller's word.
   */
  async save(entries: readonly PersistedEntry[]): Promise<void> {
    const groups = new Map<string, MessageInfo[]>();
    for (const entry of entries) {
      const roomId = roomIdOf(entry);
      const row = roomId === undefined ? undefined : asMessage(entry);
      if (roomId === undefined || row === undefined) continue;
      const rows = groups.get(roomId);
      if (rows) rows.push(row);
      else groups.set(roomId, [row]);
    }

    for (const [roomId, rows] of groups) {
      await this.saveRoom(roomId, rows, false);
    }
    for (const roomId of await this.#rooms({ missingOk: true })) {
      if (!groups.has(roomId)) await this.forgetRoom(roomId);
    }
    await this.#sweepTempFiles();
  }

  /** Drop everything in this space's directory. */
  async clear(): Promise<void> {
    try {
      await fs.rm(this.#dir, { recursive: true, force: true });
    } catch (err) {
      this.#diag?.(`cache: clearing ${this.#dir} failed`, err);
    }
  }

  /** Keep at most `#maxRows` rows, newest by message time; order preserved. */
  #bound(entries: readonly PersistedEntry[]): PersistedEntry[] {
    const max = this.#maxRows;
    if (entries.length <= max) return [...entries];

    const ranked = entries
      .map((entry, index) => ({ index, at: entry.at }))
      .sort((a, b) => b.at - a.at || b.index - a.index);
    const keep = new Set(ranked.slice(0, max).map((r) => r.index));
    const kept = entries.filter((_, index) => keep.has(index));
    this.#diag?.(
      `cache: dropped ${entries.length - kept.length} rows over the per-room budget`,
    );
    return kept;
  }

  /**
   * Room ids with a file in this space's directory. The id is the file name
   * decoded, so a caller never has to know how a name was formed.
   */
  async #rooms(opts: { missingOk?: boolean } = {}): Promise<string[]> {
    try {
      const names = await fs.readdir(this.#dir);
      return names
        .filter((name) => name.endsWith(".json"))
        .map((name) => decodeURIComponent(name.slice(0, -".json".length)))
        .sort();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || !opts.missingOk) {
        this.#diag?.("cache: listing failed", err);
      }
      return [];
    }
  }

  /** Remove temp files left by a process killed between write and rename. */
  async #sweepTempFiles(): Promise<void> {
    try {
      for (const name of await fs.readdir(this.#dir)) {
        if (!name.startsWith(TEMP_PREFIX)) continue;
        await fs.rm(path.join(this.#dir, name), { force: true });
      }
    } catch (err) {
      this.#diag?.("cache: sweeping temp files failed", err);
    }
  }
}

/** The room a persisted row belongs to, or `undefined` for a foreign entry. */
export function roomIdOf(entry: PersistedEntry): string | undefined {
  const params = entry.key[1];
  if (typeof params !== "object" || params === null) return undefined;
  const roomId = (params as Record<string, unknown>).roomId;
  return typeof roomId === "string" ? roomId : undefined;
}

/**
 * The message a persisted row holds, or `undefined` when the `state` is not a
 * message row or its id disagrees with the entry's key. A rejected row is
 * dropped; a caller never echoes an unvalidated `state`.
 */
function asMessage(entry: PersistedEntry): MessageInfo | undefined {
  const params = entry.key[1];
  if (typeof params !== "object" || params === null) return undefined;
  const state = entry.state;
  if (typeof state !== "object" || state === null) return undefined;
  const row = state as Record<string, unknown>;
  if (typeof row.id !== "string") return undefined;
  if (row.id !== (params as Record<string, unknown>).messageId) return undefined;
  if (typeof row.authorDid !== "string") return undefined;
  if (typeof row.authorName !== "string") return undefined;
  if (typeof row.content !== "string") return undefined;
  if (typeof row.timestamp !== "string") return undefined;
  return entry.state as MessageInfo;
}

/**
 * Build persisted entries for a room's rows, oldest → newest. One entry per
 * message, keyed by message id; `at` is the message time, which is the recency
 * the store's bound ranks by.
 */
export function rowsToEntries(
  roomId: string,
  rows: readonly MessageInfo[],
): PersistedEntry[] {
  return rows.map((row) => {
    // A system message carries no timestamp; it ranks oldest (0) rather than
    // NaN, which the seam's entry check rejects outright.
    const at = Date.parse(row.timestamp);
    return {
      key: cache.queryKey(ROOM_NSID, { roomId, messageId: row.id }),
      state: row,
      at: Number.isFinite(at) ? at : 0,
    };
  });
}
