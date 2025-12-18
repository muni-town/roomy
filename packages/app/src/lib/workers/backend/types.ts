import type { AsyncChannel } from "../asyncChannel";
import type { QueryResult } from "../sqlite/setup";
import type { Batch, EncodedStreamEvent, StreamIndex } from "../types";
import type { Profile } from "../../types/profile";
import type { MessagePortApi } from "../workerMessaging";
import type { Client } from "./client";
import type { BlobRef } from "@atproto/lexicon";
import type { Deferred } from "$lib/utils/deferred";
import type { SqliteWorkerInterface, SqlStatement } from "../sqlite/types";
import type { ConnectedStream } from "./stream";
import type { Did, DidStream, DidUser, Event, Handle } from "$lib/schema";

export interface BackendStatus {
  authState: ReactiveAuthState;
  profile: Profile;
  spaces: Record<DidStream, "loading" | "idle" | "error">;
}

export type BackendInterface = {
  login(username: Handle): Promise<string>;
  logout(): Promise<void>;
  oauthCallback(searchParams: string): Promise<void>;
  runQuery(statement: SqlStatement): Promise<QueryResult<unknown>>;
  getProfile(did: DidUser): Promise<Profile | undefined>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<{ done: true } | { done: false; error: string }>;
  ping(): Promise<{ timestamp: number }>;
  enableLogForwarding(): Promise<void>;
  disableLogForwarding(): Promise<void>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  sendEvent(streamId: DidStream, payload: Event): Promise<void>;
  sendEventBatch(streamId: DidStream, payloads: Event[]): Promise<void>;
  fetchEvents(
    streamId: DidStream,
    offset: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]>;
  previewSpace(streamId: DidStream): Promise<{ name: string }>;
  setActiveSqliteWorker(port: MessagePort): Promise<void>;
  pauseSubscription(streamId: DidStream): Promise<void>;
  unpauseSubscription(streamId: DidStream): Promise<void>;
  resolveHandleForSpace(
    spaceId: DidStream,
    handleAccountDid: Did,
  ): Promise<Handle | undefined>;
  resolveSpaceId(spaceIdOrHandle: DidStream | Handle): Promise<{
    spaceId: DidStream;
    handle?: Handle;
    did?: Did;
  }>;
  checkSpaceExists(spaceId: DidStream): Promise<boolean>;
  createStreamHandleRecord(spaceId: DidStream): Promise<void>;
  removeStreamHandleRecord(): Promise<void>;
  connectSpaceStream(spaceId: DidStream, idx: StreamIndex): Promise<void>;
  createSpaceStream(): Promise<DidStream>;
  /** Testing: Get personal stream record from PDS */
  getStreamRecord(): Promise<{ id: string } | null>;
  /** Testing: Delete personal stream record from PDS */
  deleteStreamRecord(): Promise<void>;
  /** Testing: Trigger personal stream creation */
  ensurePersonalStream(): Promise<void>;
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

export namespace AuthStates {
  export interface Unauthenticated {
    state: "unauthenticated";
  } // implies workerRunning, authLoaded

  export interface AuthLoading {
    state: "loading";
  }

  export interface OAuthRedirecting {
    state: "redirecting";
  }

  export interface Authenticated {
    state: "authenticated";
    client: Client;
    eventChannel: AsyncChannel<Batch.Event>;
  } // implies leafConnected, has personalStreamId

  export interface AuthError {
    state: "error";
    error: string;
  }

  export interface ReactiveAuthenticated {
    state: "authenticated";
    did: DidUser;
    personalStream: DidStream;
    clientStatus: StreamConnectionStatus["status"];
  }
}

export type AuthState =
  | AuthStates.Unauthenticated
  | AuthStates.AuthLoading
  | AuthStates.OAuthRedirecting
  | AuthStates.Authenticated
  | AuthStates.AuthError;

export type ReactiveAuthState =
  | AuthStates.Unauthenticated
  | AuthStates.AuthLoading
  | AuthStates.OAuthRedirecting
  | AuthStates.ReactiveAuthenticated
  | AuthStates.AuthError;

export interface ConnectionState {
  ports: WeakMap<MessagePortApi, string>;
  count: number;
}
export interface WorkerConfig {
  consoleForwarding: boolean;
}

export type StreamConnectionStatus =
  | ConnectionStates.Error
  | ConnectionStates.Offline
  | ConnectionStates.InitialisingStreams
  | ConnectionStates.ConnectedStreams;

export namespace ConnectionStates {
  export interface Error {
    __brand: "connectionError";
    status: "error";
    message: string;
  }

  export interface Offline {
    status: "offline";
  }

  export interface InitialisingStreams {
    status: "initialising";
  }

  export interface ConnectedStreams {
    status: "connected";
    personalStream: ConnectedStream;
    eventChannel: AsyncChannel<Batch.Event>;
    streams: Map<DidStream, ConnectedStream>;
  }
}

type SqlitePending = {
  state: "pending";
  readyPromise: Deferred<void>;
};

type SqliteReady = {
  state: "ready";
  sqliteWorker: SqliteWorkerInterface;
};

export type SqliteState = SqlitePending | SqliteReady;
