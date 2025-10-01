import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { EventType } from "./materializer";
import type { BlobRef } from "@atproto/lexicon";
import type { QueryResult } from "./setupSqlite";
import type { SqlStatement } from "./backendWorker";
import type { IncomingEvent } from "@muni-town/leaf-client";

export interface BackendStatus {
  authLoaded: boolean | undefined;
  did: string | undefined;
  profile: ProfileViewDetailed | undefined;
  leafConnected: boolean | undefined;
  personalStreamId: string | undefined;
}
export interface SqliteStatus {
  isActiveWorker: boolean | undefined;
}

export type BackendInterface = {
  login(username: string): Promise<string>;
  logout(): Promise<void>;
  oauthCallback(searchParams: string): Promise<void>;
  runQuery(statement: SqlStatement): Promise<QueryResult>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<unknown>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  sendEvent(streamId: string, payload: EventType): Promise<void>;
  sendEventBatch(streamId: string, payloads: EventType[]): Promise<void>;
  fetchEvents(streamId: string, offset: number, limit: number): Promise<IncomingEvent[]>;
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
  uploadImage(
    bytes: ArrayBuffer,
    alt?: string,
  ): Promise<{ blob: BlobRef; uri: string; cid: string; url: string }>;
  /** Adds a new message port connection to the backend that can call the backend interface. */
  addClient(port: MessagePort): Promise<void>;
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
  runQuery(statement: SqlStatement): Promise<QueryResult>;
  runSavepoint(savepoint: Savepoint): Promise<void>;
};