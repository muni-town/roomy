/**
 * Local types for the appserver materialisation pipeline.
 *
 * We run synchronously inside a single Bun process, so there is no
 * cross-worker channel and no priority queue to model. Only the shapes that
 * meaningfully flow through the pipeline are kept.
 */

import type {
  DecodedStreamEvent,
  Event,
  SqlStatement,
  StreamDid,
  StreamIndex,
  Ulid,
  UserDid,
} from "@roomy-space/sdk";

export type { SqlStatement } from "@roomy-space/sdk";

/** Successful materialisation of one event into a list of SQL statements. */
export interface StatementBundleSuccess {
  status: "success";
  event: Event;
  eventIdx: StreamIndex;
  user: UserDid;
  statements: SqlStatement[];
  /** Other event ULIDs that must already be applied for this one to be valid. */
  dependsOn: Ulid[];
}

/** Materialiser threw — typically a malformed payload for a known event type. */
export interface StatementBundleError {
  status: "error";
  eventId: Ulid;
  message: string;
}

/**
 * An entry the batch applied nothing for, and did not fail on. Two cases,
 * counted apart because they mean different things:
 *
 * - `undecodable`: the payload decoded but carries no `$type`, so the event's
 *   kind is unknown. Typically a legacy or foreign event encoding rather than
 *   a corrupt row; the replayer reports it with the payload's byte length.
 * - `unregistered`: the event names a kind this build has no materialiser for.
 */
export interface StatementBundleSkip {
  status: "skip";
  /** The event's ULID, when the decoded payload carries one. */
  eventId: Ulid | null;
  reason: "undecodable" | "unregistered";
  /** The decoded `$type`, or `null` when the payload carries none. */
  kind: string | null;
}

export type StatementBundle =
  | StatementBundleSuccess
  | StatementBundleError
  | StatementBundleSkip;

/** Per-event apply outcomes after the SQL has been (or hasn't been) executed. */
export type ApplyOutcome =
  | { result: "applied"; eventId: Ulid }
  | { result: "stashed"; eventId: Ulid; dependsOn: Ulid[] }
  | { result: "error"; eventId: Ulid; error: string };

/**
 * A decoded event plus the clocks the event log recorded for its row.
 *
 * `receivedAt` is `stream_events.received_at`: the instant the server accepted
 * the event, and the ordering key's time component for a message the sender's
 * own clock cannot be trusted to place (see `sortIdx.ts`). `createdAt` is
 * `stream_events.created_at`, the same observation at second resolution, and
 * is the ordering key's second fallback for a row whose append stamped no
 * receipt. Both are server-side materialisation metadata, so they are carried
 * here rather than on the SDK's `DecodedStreamEvent`, which is also the shape
 * handed to clients.
 *
 * Optional because a row imported from another store carries neither; the
 * ordering key then falls back to the event's own ULID time.
 */
export interface LoggedEvent extends DecodedStreamEvent {
  receivedAt?: number;
  createdAt?: number;
}

/** Context for materialiser invocations. */
export interface MaterializeOpts {
  streamId: StreamDid;
  user: UserDid;
  /**
   * The instant the log assigns the entry, in epoch milliseconds. A materialiser
   * stamps the rows it writes from it, so a replay reproduces the live write.
   * A caller that omits it gets wall-clock time, which only a caller with no
   * log behind it can want.
   */
  decidedAt?: number;
}
