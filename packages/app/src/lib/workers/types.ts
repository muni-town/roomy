import type {
  Did,
  Ulid,
  StreamIndex,
  StreamDid,
  Handle,
  Event,
  UserDid,
  DecodedStreamEvent,
} from "@roomy/sdk";
import type { QueryResult } from "./sqlite/setup";
import type { SqlStatement } from "./sqlite/types";
import type { BindingSpec } from "@sqlite.org/sqlite-wasm";

export type EdgeLabel =
  | "child"
  | "parent"
  | "subscribe"
  | "member"
  | "ban"
  | "hide"
  | "pin"
  | "embed"
  | "reply"
  | "link"
  | "author"
  | "reorder"
  | "source"
  | "avatar"
  | "reaction";

export interface EdgeReaction {
  reaction: string;
}

export interface EdgeBan {
  reason: string;
  banned_by: Did;
}

export interface EdgeMember {
  // delegation?: string;
  can: "read" | "post" | "admin";
}

export interface EdgesWithPayload {
  reaction: EdgeReaction;
  ban: EdgeBan;
  member: EdgeMember;
}

export { type StreamIndex };

export type EdgesMap = {
  [K in Exclude<EdgeLabel, keyof EdgesWithPayload>]: null;
} & EdgesWithPayload;

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], Did | Ulid];
};

export type SpaceIdOrHandle = StreamDid | Handle;

export type TaskPriority = "priority" | "background";

/** SqliteWorker handles a pipeline of batched computations, transforming
 * batches from Events to SQL Statements to Results
 */
export namespace Batch {
  export interface Events {
    status: "events";
    batchId: Ulid;
    streamId: StreamDid;
    events: DecodedStreamEvent[];
    priority: TaskPriority;
  }

  export interface Unstash {
    status: "unstash";
    batchId: Ulid;
    streamId: StreamDid;
    priority: TaskPriority;
    events: Array<DecodedStreamEvent>;
  }

  export interface Statement {
    status: "transformed";
    batchId: Ulid;
    streamId: StreamDid;
    bundles: Bundle.Statement[];
    latestEvent: StreamIndex;
    priority: TaskPriority;
  }

  export interface ApplyResult {
    status: "applied";
    batchId: Ulid;
    results: (
      | Bundle.ApplyResult
      | Bundle.ProfileApplyResult
      | Bundle.ApplyError
      | Bundle.ApplyStashed
    )[];
    priority: TaskPriority;
    summary: MaterializationSummary;
    warnings: MaterializationWarnings;
  }
}

export interface ApplyResultError {
  type: "error";
  statement: SqlStatement;
  message: string;
}

/** A successfully executed statement with full details */
export interface ApplyResultSuccess {
  type: "success";
  sql: string;
  params?: BindingSpec;
  rows?: number; // Number of rows affected or returned
  durationMs?: number; // Time taken to execute
}

export interface MaterializationWarnings {
  /** Events that were stashed due to unmet dependencies */
  stashedEvents?: Array<{ eventId: Ulid; dependsOn: Ulid[] }>;
  /** Events that had errors during materialization or execution */
  failedEvents?: Array<{ eventId: Ulid; error: string }>;
  /** Statements that failed within otherwise successful bundles */
  failedStatements?: Array<{ eventId: Ulid; statement: string; error: string }>;
}

export interface MaterializationSummary {
  totalEvents: number;
  appliedEvents: number;
  stashedEvents: number;
  errorEvents: number;
  totalStatements: number;
  successfulStatements: number;
  failedStatements: number;
  durationMs: number;
}

interface ApplyErrorMissingDependency {
  type: "missingDependency";
  dependency: Ulid;
}

type ApplyErrorType = ApplyErrorMissingDependency;

/** Bundles are the units of data (events, statements, results) in batches */
export namespace Bundle {
  /** For a given batch of incoming events, certain event kinds trigger checks to
   * ensureProfile so we can make sure we have the user for that event. These
   * async requests are bundled together as an optimisation. */
  export interface StatementProfile {
    status: "profiles";
    dids: Did[];
    statements: SqlStatement[];
  }

  interface StatementProfileError {
    status: "profileError";
    dids: Set<Did>;
    message: string;
  }

  export interface StatementSuccess {
    status: "success";
    event: Event;
    eventIdx: StreamIndex;
    user: UserDid;
    statements: SqlStatement[];
    dependsOn: Ulid[];
  }

  export interface StatementError {
    status: "error";
    eventId?: Ulid;
    message: string;
  }

  export type Statement =
    | StatementSuccess
    | StatementProfile
    | StatementProfileError
    | StatementError;

  export interface ProfileApplyResult {
    result: "appliedProfiles";
    firstDid?: Did;
    output: (ApplyResultSuccess | ApplyResultError)[];
  }

  export interface ApplyResult {
    result: "applied";
    eventId: Ulid;
    output: (ApplyResultSuccess | ApplyResultError)[];
  }

  export interface ApplyStashed {
    result: "stashed";
    eventId: Ulid;
    dependsOn: Ulid[];
  }

  export interface ApplyError {
    result: "error";
    eventId: Ulid;
    error: ApplyErrorType;
  }
}
