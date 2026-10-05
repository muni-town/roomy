/**
 * `roomy export` — download a room's, or a whole space's, message history.
 *
 * A snapshot of every message in every channel and thread of a space (or of one
 * room), written as JSON or CSV so other programs can read it: local analysis,
 * NER, embeddings.
 *
 * History lands in the CLI's filesystem store as it is fetched, and a re-run
 * reads what is there. The server's cursor means *older than* — it cannot
 * express "newer than X" — so catching up is expressed as: walk from the newest
 * message down and stop at the first message already stored. A room whose
 * stored rows are already complete and current costs no request at all.
 * `--refresh` ignores the store and walks every room from the newest message.
 */

import * as path from "node:path";
import { transport } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

import { MAX_PAGE_LIMIT, readMessagePage, type MessageInfo } from "./messages.js";
import { FileStore, spaceDir } from "./store.js";

/** One exported message: the CSV columns, and one JSON array element. */
export interface ExportRow {
  id: string;
  timestamp: string;
  authorDid: string;
  authorName: string;
  roomId: string;
  roomName: string;
  replyTo: string | null;
  text: string;
}

/** A room to export, with the name that goes into every row of it. */
export interface RoomTarget {
  id: string;
  name: string;
  /**
   * The room's newest message as the board reports it, which is what a stored
   * history is checked against before it is trusted as current. `undefined`
   * when the board did not name one (the room has no messages, or the id was
   * given without the room being on the board) — then the walk runs.
   */
  latestMessageId?: string;
}

export interface ExportOptions {
  spaceId: string;
  /** One room only. Omitted exports every channel and thread in the space. */
  roomId?: string;
  /** Ignore the store and refetch every room from the newest message. */
  refresh?: boolean;
  /** Cap messages per room, newest first. Omitted exports all of them. */
  limit?: number;
  /** DID the store belongs to; a store written for another DID is ignored. */
  account: string;
  /** Root of the filesystem cache. */
  cacheDir: string;
  /** One progress line per finished room. */
  onProgress?: (line: string) => void;
}

export interface ExportResult {
  rows: ExportRow[];
  /** Rooms that were exported, in output order. */
  rooms: RoomTarget[];
  /** Messages fetched from the server this run. */
  fetched: number;
  /** Messages answered from the store without a request. */
  cached: number;
  /** Rooms skipped because their history could not be read. */
  failed: RoomTarget[];
}

/**
 * Export every message of the space (or of `roomId`), reading through the
 * filesystem store and writing back what it fetched.
 */
export async function collectExport(
  xrpc: DirectXrpcClient,
  opts: ExportOptions,
): Promise<ExportResult> {
  const rooms = await listExportRooms(xrpc, opts.spaceId, opts.roomId);
  const store = new FileStore({
    dir: spaceDir(opts.cacheDir, opts.spaceId),
    account: opts.account,
    onDiagnostic: (message, detail) => console.error(message, detail ?? ""),
  });

  const rows: ExportRow[] = [];
  const failed: RoomTarget[] = [];
  let fetched = 0;
  let cached = 0;

  for (const room of rooms) {
    const stored = await store.loadRoom(room.id);
    let history: RoomHistory;
    try {
      history = await roomHistory(xrpc, room, stored, opts);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.onProgress?.(`${room.name || room.id}: skipped (${reason})`);
      failed.push(room);
      // The room's file is left exactly as it was, so a transient failure does
      // not discard a history that is still good.
      continue;
    }

    fetched += history.fetched;
    cached += history.cached;
    await store.saveRoom(room.id, history.messages, history.complete);

    const capped =
      opts.limit === undefined
        ? history.messages
        : history.messages.slice(Math.max(0, history.messages.length - opts.limit));
    for (const message of capped) rows.push(toExportRow(message, room));
    opts.onProgress?.(
      `${room.name || room.id}: ${capped.length} messages` +
        ` (${history.fetched} fetched, ${history.cached} from store)`,
    );
  }

  return { rows, rooms, fetched, cached, failed };
}

interface RoomHistory {
  /** The room's rows, oldest → newest. */
  messages: MessageInfo[];
  /** Whether `messages` reaches the room's oldest message. */
  complete: boolean;
  fetched: number;
  cached: number;
}

/**
 * A room's history: the stored rows plus however much had to be fetched to
 * reach the newest message. Stored rows form the older part of the timeline —
 * the walk stops at the first message already stored — so the merge is a
 * concatenation, deduplicated by id.
 */
async function roomHistory(
  xrpc: DirectXrpcClient,
  room: RoomTarget,
  stored: { rows: MessageInfo[]; complete: boolean },
  opts: ExportOptions,
): Promise<RoomHistory> {
  const known = stored.rows;

  // Nothing to ask for: the stored rows reach the board's newest message for
  // this room and cover as much of it as this run wants — the whole room when
  // the walk is uncapped and the store is complete, or the newest `--limit`
  // rows when the store holds at least that many. An empty room the board also
  // reports as empty is the same case with nothing stored.
  const enoughForCap = opts.limit !== undefined && known.length >= opts.limit;
  const boardSaysEmpty = room.latestMessageId === undefined;
  if (
    !opts.refresh &&
    known.length === 0 &&
    stored.complete &&
    boardSaysEmpty
  ) {
    return { messages: [], complete: true, fetched: 0, cached: 0 };
  }
  if (
    !opts.refresh &&
    known.length > 0 &&
    (stored.complete || enoughForCap) &&
    room.latestMessageId === known[known.length - 1]!.id
  ) {
    return {
      messages: known,
      complete: stored.complete,
      fetched: 0,
      cached: known.length,
    };
  }

  // Stopping at a stored id is only sound when the rows below it are stored
  // too: the rows below the stop are exactly the stored block. A walk over a
  // capped store has no such block (its tail is the newest N of a longer
  // room), so it runs until the room or the cap ends it and supersedes the
  // store.
  const knownIds = new Set(known.map((m) => m.id));
  const stopAtKnown = !opts.refresh && stored.complete;
  const target = opts.limit;
  const pages: MessageInfo[][] = [];
  let kept = 0;
  let reachedKnown = false;
  let walkedToEnd = false;
  let cursor: string | undefined;

  for (;;) {
    // A per-room cap shrinks the request too: asking for 100 messages to keep
    // 20 spends the server's work and the wire for nothing.
    const remaining = target === undefined ? MAX_PAGE_LIMIT : target - kept;
    const page = await readMessagePage(xrpc, room.id, {
      limit: Math.max(1, Math.min(MAX_PAGE_LIMIT, remaining)),
      cursor,
    });

    // The page is ascending; walking it from the end steps from the newest
    // message down to the first one already stored. Everything kept is newer
    // than that message, so the stored rows below it stay valid.
    const fresh: MessageInfo[] = [];
    for (let i = page.messages.length - 1; i >= 0; i--) {
      const message = page.messages[i]!;
      if (stopAtKnown && knownIds.has(message.id)) {
        reachedKnown = true;
        break;
      }
      fresh.unshift(message);
    }
    pages.push(fresh);
    kept += fresh.length;

    if (reachedKnown) break;
    if (target !== undefined && kept >= target) break;
    // A short page is the last one: the room's history ends here, so this walk
    // reaches its oldest message.
    if (!page.cursor || page.cursor === cursor) {
      walkedToEnd = true;
      break;
    }
    cursor = page.cursor;
  }

  // Pages were collected newest → oldest; reversing yields oldest → newest.
  const walked = pages.reverse().flat();

  // The walk stopped on a stored id: the room's history is the stored rows
  // followed by the newer rows just fetched.
  if (reachedKnown) {
    return {
      messages: [...known, ...walked],
      complete: true,
      fetched: kept,
      cached: known.length,
    };
  }

  // Otherwise the walk is the whole story — it either reached the room's
  // oldest message or stopped at the per-room cap. Either way the stored rows
  // are superseded (they hold nothing the walk did not, and a row the room no
  // longer has must not be echoed back).
  return {
    messages: walked,
    complete: walkedToEnd,
    fetched: kept,
    cached: 0,
  };
}

/** One row in the exported shape. */
function toExportRow(message: MessageInfo, room: RoomTarget): ExportRow {
  return {
    id: message.id,
    timestamp: message.timestamp,
    authorDid: message.authorDid,
    authorName: message.authorName,
    roomId: room.id,
    roomName: room.name,
    replyTo: message.replyTo ?? null,
    text: message.content,
  };
}

/**
 * The rooms to export: one room, or every channel and thread in the space.
 *
 * `space.roomy.space.getThreads`, despite its name, returns every room of the
 * space — channels and threads — filtered to the caller's read access, so one
 * cursor-paged walk enumerates the whole space and carries each room's name and
 * newest message. The single-room form walks the same board to find its room,
 * so both paths know what the room's newest message is.
 */
export async function listExportRooms(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId?: string,
): Promise<RoomTarget[]> {
  const found = new Map<string, RoomTarget>();
  let cursor: string | undefined;
  for (;;) {
    const page = await xrpc.query("space.roomy.space.getThreads", {
      spaceId,
      limit: String(MAX_PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    for (const room of page.rooms) {
      if (roomId !== undefined && room.id !== roomId) continue;
      if (found.has(room.id)) continue;
      const target: RoomTarget = { id: room.id, name: room.name ?? "" };
      const latest = room.activity.latestMessage;
      if (latest) target.latestMessageId = latest.id;
      found.set(room.id, target);
      // The single-room form is satisfied by the first match.
      if (roomId !== undefined) return [...found.values()];
    }
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }

  // A room the board did not list (unreadable, or on a page that was never
  // walked): export it anyway, with no known newest message, and let the walk
  // decide.
  if (roomId !== undefined && found.size === 0) return [{ id: roomId, name: "" }];
  return [...found.values()];
}

/** CSV header, in order. Stable: consumers address columns by name. */
export const CSV_COLUMNS = [
  "id",
  "timestamp",
  "authorDid",
  "authorName",
  "roomId",
  "roomName",
  "replyTo",
  "text",
] as const;

/**
 * RFC 4180 encoding: a field is quoted when it holds a quote, comma, CR or LF,
 * and an embedded quote is doubled. Rows end CRLF, as the RFC specifies, so a
 * field may carry a bare LF — chat text does.
 */
export function encodeCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.timestamp,
        row.authorDid,
        row.authorName,
        row.roomId,
        row.roomName,
        row.replyTo ?? "",
        row.text,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/** The same rows as JSON: an array of message objects. */
export function encodeJson(rows: readonly ExportRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** Default output path for an export. */
export function defaultOutPath(
  spaceId: string,
  format: "json" | "csv",
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  const slug = encodeURIComponent(spaceId);
  return path.join(process.cwd(), `roomy-export-${slug}-${stamp}.${format}`);
}
