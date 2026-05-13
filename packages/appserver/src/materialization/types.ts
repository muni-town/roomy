/**
 * Local types for the appserver materialisation pipeline.
 *
 * Deliberately simpler than the frontend `workers/types.ts` Bundle/Batch
 * namespaces: we run synchronously inside a single Bun process so there is no
 * cross-worker channel and no priority queue to model. Only the shapes that
 * meaningfully flow through the pipeline are kept.
 */

import type {
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

/** Context for materialiser invocations. */
export interface MaterializeOpts {
  streamId: StreamDid;
  user: UserDid;
}
