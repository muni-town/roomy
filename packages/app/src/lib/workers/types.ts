import type { Did, Ulid, StreamIndex, StreamDid, Handle } from "$lib/schema";
import type { QueryResult } from "./sqlite/setup";
import type { SqlStatement } from "./sqlite/types";

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

export interface EncodedStreamEvent {
  idx: StreamIndex;
  user: string;
  payload: Uint8Array;
}

/** SqliteWorker handles a pipeline of batched computations, transforming
 * batches from Events to SQL Statements to Results
 */
export namespace Batch {
  export interface Events {
    batchId: Ulid;
    streamId: StreamDid;
    events: EncodedStreamEvent[];
    priority: TaskPriority;
  }

  export interface Statement {
    status: "transformed";
    batchId: Ulid;
    streamId: StreamDid;
    bundles: Bundle.Statement[];
    latestEvent: StreamIndex;
    priority: TaskPriority;
    spacesToConnect: StreamDid[];
  }

  export interface ApplyResult {
    status: "applied";
    batchId: Ulid;
    results: (
      | Bundle.ApplyResult
      | Bundle.ProfileApplyResult
      | Bundle.ApplyError
    )[];
    priority: TaskPriority;
  }
}

export interface ApplyResultError {
  type: "error";
  statement: SqlStatement;
  message: string;
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
    eventId: Ulid;
    eventIdx: StreamIndex;
    statements: SqlStatement[];
    dependsOn: Ulid | null;
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
    output: (QueryResult | ApplyResultError)[];
  }

  export interface ApplyResult {
    result: "applied";
    eventId: Ulid;
    output: (QueryResult | ApplyResultError)[];
  }

  export interface ApplyError {
    result: "error";
    eventId: Ulid;
    error: ApplyErrorType;
  }
}
