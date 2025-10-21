import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { EventType } from "./materializer";
import type { BlobRef } from "@atproto/lexicon";
import type { QueryResult } from "./setupSqlite";
import type { SqlStatement } from "./backendWorker";
import type { IncomingEvent } from "@muni-town/leaf-client";

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
