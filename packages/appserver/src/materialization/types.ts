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

/** Materialiser threw — typically an unknown event type or a schema error. */
export interface StatementBundleError {
  status: "error";
  eventId: Ulid;
  message: string;
}

export type StatementBundle = StatementBundleSuccess | StatementBundleError;

/** Per-event apply outcomes after the SQL has been (or hasn't been) executed. */
export type ApplyOutcome =
  | { result: "applied"; eventId: Ulid }
  | { result: "stashed"; eventId: Ulid; dependsOn: Ulid[] }
  | { result: "error"; eventId: Ulid; error: string };

/**
 * A decoded event plus the receipt time the event log recorded for it.
 *
 * `receivedAt` is `stream_events.received_at`: the instant the server accepted
 * the event, which is the ordering key's time component for a message the
 * sender's own clock cannot be trusted to place (see `sortIdx.ts`). It is
 * server-side materialisation metadata, so it is carried here rather than on
 * the SDK's `DecodedStreamEvent`, which is also the shape handed to clients.
 *
 * Optional because an event logged before the column existed has no receipt
 * time; the ordering key then falls back to the event's own ULID time.
 */
export interface LoggedEvent extends DecodedStreamEvent {
  receivedAt?: number;
}

/** Context for materialiser invocations. */
export interface MaterializeOpts {
  streamId: StreamDid;
  user: UserDid;
}
