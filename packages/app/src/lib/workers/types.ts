import type { QueryResult } from "./sqlite/setup";
import type { eventCodec } from "./encoding";
import type { Did } from "@atproto/api";
import type { SqlStatement } from "./sqlite/types";

type RawEvent = ReturnType<(typeof eventCodec)["dec"]>;
type EventKind = RawEvent["variant"]["kind"];

export type EventType<TVariant extends EventKind | undefined = undefined> =
  TVariant extends undefined
    ? RawEvent
    : Omit<RawEvent, "variant"> & {
        variant: Extract<RawEvent["variant"], { kind: TVariant }>;
      };

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

type EntityId = string & { __brand: "entityId" };

export interface EdgeReaction {
  reaction: string;
}

export interface EdgeBan {
  reason: string;
  banned_by: EntityId;
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

export type EdgesMap = {
  [K in Exclude<EdgeLabel, keyof EdgesWithPayload>]: null;
} & EdgesWithPayload;

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], EntityId];
};

export type StreamHashId = string & { __brand: "streamHashId" };

export type Ulid = string & { __brand: "ulid" };

export type Handle = string & { __brand: "handle" };

export type SpaceIdOrHandle = StreamHashId | Handle;

export type StreamIndex = number & { __brand: "streamIndex" };

export type TaskPriority = "priority" | "background";

export interface EncodedStreamEvent {
  idx: StreamIndex;
  user: string;
  payload: ArrayBufferLike;
}

/** SqliteWorker handles a pipeline of batched computations, transforming
 * batches from Events to SQL Statements to Results
 */
export namespace Batch {
  export interface EventFetch {
    status: "fetched";
    batchId: Ulid;
    streamId: StreamHashId;
    events: EncodedStreamEvent[];
    priority: TaskPriority;
  }

  export interface EventPushed {
    status: "pushed";
    batchId: Ulid;
    streamId: StreamHashId;
    events: [EncodedStreamEvent];
    priority: TaskPriority;
  }
  export type Event = EventFetch | EventPushed;

  export interface Statement {
    status: "transformed";
    batchId: Ulid;
    streamId: StreamHashId;
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
