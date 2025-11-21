import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { BlobRef } from "@atproto/lexicon";
import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import type { QueryResult } from "./sqlite/setup";
import type { IncomingEvent } from "@muni-town/leaf-client";
import type { eventCodec } from "./encoding";
import type { ReactiveAuthState } from "./backend/worker";
import type { AsyncChannel } from "./asyncChannel";
import type { Did } from "@atproto/api";
import type { Deferred } from "$lib/utils/deferred";

export interface BackendStatus {
  authState: ReactiveAuthState;
  profile: Profile;
  loadingSpaces: number;
}
export interface SqliteStatus {
  isActiveWorker: boolean;
  workerId: string;
  vfsType: string;
}
export interface Profile {
  id: string;
  handle?: string;
  avatar?: string;
  displayName?: string;
  banner?: string;
  description?: string;
}

export type BackendInterface = {
  login(username: string): Promise<string>;
  logout(): Promise<void>;
  oauthCallback(searchParams: string): Promise<void>;
  runQuery(statement: SqlStatement): Promise<QueryResult<unknown>>;
  getProfile(did: string): Promise<Profile | undefined>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<unknown>;
  ping(): Promise<{ timestamp: number }>;
  enableLogForwarding(): Promise<void>;
  disableLogForwarding(): Promise<void>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  sendEvent(streamId: string, payload: EventType): Promise<void>;
  sendEventBatch(streamId: string, payloads: EventType[]): Promise<void>;
  fetchEvents(
    streamId: string,
    offset: number,
    limit: number,
  ): Promise<IncomingEvent[]>;
  previewSpace(streamId: string): Promise<{ name: string }>;
  setActiveSqliteWorker(port: MessagePort): Promise<void>;
  pauseSubscription(streamId: string): Promise<void>;
  unpauseSubscription(streamId: string): Promise<void>;
  resolveHandleForSpace(
    spaceId: string,
    handleAccountDid: string,
  ): Promise<string | undefined>;
  resolveSpaceFromHandleOrDid(
    handle: string,
  ): Promise<{ spaceId: string; handleDid: string } | undefined>;
  createStreamHandleRecord(spaceId: string): Promise<void>;
  removeStreamHandleRecord(): Promise<void>;
  createStream(
    ulid: string,
    moduleId: string,
    moduleUrl: string,
    params?: ArrayBuffer,
  ): Promise<string>;
  uploadToPds(
    bytes: ArrayBuffer,
    opts?: { alt?: string; mimetype?: string },
  ): Promise<{
    blob: ReturnType<BlobRef["toJSON"]>;
    uri: string;
  }>;
  /** Adds a new message port connection to the backend that can call the backend interface. */
  addClient(port: MessagePort): Promise<void>;
};

export type SqliteWorkerInterface = {
  materializeBatch(
    events: EventBatch,
    priority: "normal" | "background",
  ): Promise<StatementBatch | ApplyResultBatch>;
  runQuery<Row>(statement: SqlStatement): Promise<QueryResult<Row>>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  ping(): Promise<{ timestamp: number; workerId: string; isActive: boolean }>;
  runSavepoint(savepoint: Savepoint): Promise<void>;
};

export type MaterializeResult = {};

export const consoleLogLevels = [
  "trace",
  "debug",
  "log",
  "info",
  "warn",
  "error",
] as const;
export type ConsoleLogLevel = (typeof consoleLogLevels)[number];
export type ConsoleInterface = {
  log(level: ConsoleLogLevel, ...args: any[]): Promise<void>;
};

export interface SqlStatement {
  sql: string;
  params?: BindingSpec;
  /** If this is true, the query will not be pre-compiled and cached. Use this when you have to
   * substitute strings into the sql query instead of using params, because that will mess up the
   * cache which must be indexed by the SQL. */
  cache?: boolean;
}

export interface StreamEvent {
  idx: StreamIndex;
  user: string;
  payload: ArrayBuffer;
}

export interface Savepoint {
  name: string;
  items: (SqlStatement | Savepoint)[];
}

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

type EntityId = string;
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

export type StreamConnectionStatus =
  | ConnectionError
  | Offline
  | InitialisingStreams
  | LoadingPersonalStream
  | ConnectedStreams;

interface ConnectionError {
  __brand: "connectionError";
  status: "error";
  message: string;
}

interface Offline {
  status: "offline";
}

interface InitialisingStreams {
  status: "initialising";
}

export interface LoadingPersonalStream {
  status: "loadingPersonalStream";
  personalStream: ConnectedStream;
  eventChannel: AsyncChannel<EventBatch>;
}

export interface ConnectedStreams {
  status: "connected";
  personalStream: ConnectedStream;
  eventChannel: AsyncChannel<EventBatch>;
  streams: Map<StreamHashId, ConnectedStream>;
}

export interface ConnectedStream {
  id: StreamHashId;
  pin: PinState;
}

type PinState = PinRooms | PinSpace;

interface PinRooms {
  type: "rooms";
  rooms: Set<BackfillStatus>;
}

interface PinSpace {
  type: "space";
  backfill: BackfillStatus;
}

export type BackfillStatus =
  | BackfillError
  | BackfillPriority
  | BackfillBackground
  | BackfillSuspended;

interface BackfillError {
  __brand: "backfillError";
  status: "error";
  message: string;
}

interface BackfillPriority {
  status: "priority";
  upToEventId: number;
  completed: Deferred;
}

interface BackfillBackground {
  status: "background";
  upToEventId: number;
  completed: Deferred;
}

interface BackfillSuspended {
  status: "suspended";
  upToEventId: number;
}

export type Ulid = string & { __brand: "ulid" };

export type StreamIndex = number & { __brand: "streamIndex" };

export type TaskPriority = "normal" | "background";

export interface EventFetchBatch {
  status: "fetched";
  batchId: Ulid;
  streamId: StreamHashId;
  events: StreamEvent[];
  priority: TaskPriority;
}

export interface EventPushedBatch {
  status: "pushed";
  batchId: Ulid;
  streamId: StreamHashId;
  events: [StreamEvent];
  priority: TaskPriority;
}

export type EventBatch = EventFetchBatch | EventPushedBatch;

/** For a given batch of incoming events, certain event kinds trigger checks to
 * ensureProfile so we can make sure we have the user for that event. These
 * async requests are bundled together as an optimisation. */
interface StatementProfileBundle {
  status: "profiles";
  dids: Did[];
  statements: SqlStatement[];
}

interface StatementProfileErrorBundle {
  status: "profileError";
  dids: Set<Did>;
  message: string;
}

export interface StatementSuccessBundle {
  status: "success";
  eventId: Ulid;
  statements: SqlStatement[];
}

interface StatementErrorBundle {
  status: "error";
  eventId: Ulid;
  message: string;
}

export type StatementBundle =
  | StatementSuccessBundle
  | StatementProfileBundle
  | StatementProfileErrorBundle
  | StatementErrorBundle;

export interface StatementBatch {
  status: "transformed";
  batchId: Ulid;
  streamId: StreamHashId;
  bundles: StatementBundle[];
  latestEvent: StreamIndex;
  priority: TaskPriority;
}

export interface ApplyResultError {
  type: "error";
  statement: SqlStatement;
  message: string;
}

export interface ApplyResultBundle {
  result: "applied";
  eventId: Ulid;
  output: (QueryResult | ApplyResultError)[];
}

interface ApplyErrorMissingDependency {
  type: "missingDependency";
  dependency: Ulid;
}

type ApplyError = ApplyErrorMissingDependency;

interface ApplyErrorBundle {
  result: "error";
  eventId: Ulid;
  error: ApplyError;
}

export interface ApplyResultBatch {
  status: "applied";
  batchId: Ulid;
  results: (ApplyResultBundle | ApplyErrorBundle)[];
  priority: TaskPriority;
}

type Batch = EventBatch | StatementBatch | ApplyResultBatch;
