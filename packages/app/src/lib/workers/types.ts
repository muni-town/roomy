import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { BlobRef } from "@atproto/lexicon";
import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import type { QueryResult } from "./sqlite/setup";
import type { IncomingEvent } from "@muni-town/leaf-client";
import type { eventCodec } from "./encoding";

export interface BackendStatus {
  workerRunning: boolean | undefined;
  authLoaded: boolean | undefined;
  did: string | undefined;
  profile: ProfileViewDetailed | undefined;
  leafConnected: boolean | undefined;
  personalStreamId: string | undefined;
  loadingSpaces: number | undefined;
}
export interface SqliteStatus {
  isActiveWorker: boolean | undefined;
  workerId: string | undefined;
  vfsType: string | undefined;
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
  runQuery(statement: SqlStatement): Promise<QueryResult>;
  loadProfile(did: string): Promise<Profile | undefined>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<unknown>;
  ping(): Promise<{ timestamp: number; workerId: string }>;
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
    opts?: { alt?: string; mimeType?: string },
  ): Promise<{
    blob: ReturnType<BlobRef["toJSON"]>;
    uri: string;
  }>;
  /** Adds a new message port connection to the backend that can call the backend interface. */
  addClient(port: MessagePort): Promise<void>;
};

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

export type SqlStatement = {
  sql: string;
  params?: BindingSpec;
  /** If this is true, the query will not be pre-compiled and cached. Use this when you have to
   * substitute strings into the sql query instead of using params, because that will mess up the
   * cache which must be indexed by the SQL. */
  cache?: boolean;
};

export type StreamEvent = {
  idx: number;
  user: string;
  payload: ArrayBuffer;
};

export type Savepoint = {
  name: string;
  items: (SqlStatement | Savepoint)[];
};

export type SqliteWorkerInterface = {
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  runQuery<Row>(statement: SqlStatement): Promise<QueryResult<Row>>;
  runSavepoint(savepoint: Savepoint): Promise<void>;
  ping(): Promise<{ timestamp: number; workerId: string; isActive: boolean }>;
};

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
