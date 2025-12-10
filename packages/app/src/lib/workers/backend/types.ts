import type { AsyncChannel } from "../asyncChannel";
import type { QueryResult } from "../sqlite/setup";
import type {
  Batch,
  EncodedStreamEvent,
  EventType,
  Handle,
  StreamHashId,
} from "../types";
import type { Profile } from "../../types/profile";
import type { MessagePortApi } from "../workerMessaging";
import type { Client } from "./client";
import type { BlobRef } from "@atproto/lexicon";
import type { Deferred } from "$lib/utils/deferred";
import type { SqliteWorkerInterface, SqlStatement } from "../sqlite/types";
import type { Did } from "@atproto/api";

export interface BackendStatus {
  authState: ReactiveAuthState;
  profile: Profile;
  spaces: Record<StreamHashId, "loading" | "idle" | "error">;
}

export type BackendInterface = {
  login(username: string): Promise<string>;
  logout(): Promise<void>;
  oauthCallback(searchParams: string): Promise<void>;
  runQuery(statement: SqlStatement): Promise<QueryResult<unknown>>;
  getProfile(did: Did): Promise<Profile | undefined>;
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
  sendEvent(streamId: StreamHashId, payload: EventType): Promise<void>;
  sendEventBatch(streamId: StreamHashId, payloads: EventType[]): Promise<void>;
  fetchEvents(
    streamId: StreamHashId,
    offset: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]>;
  previewSpace(streamId: StreamHashId): Promise<{ name: string }>;
  setActiveSqliteWorker(port: MessagePort): Promise<void>;
  pauseSubscription(streamId: StreamHashId): Promise<void>;
  unpauseSubscription(streamId: StreamHashId): Promise<void>;
  resolveHandleForSpace(
    spaceId: StreamHashId,
    handleAccountDid: Did,
  ): Promise<Handle | undefined>;
  resolveSpaceId(spaceIdOrHandleOrDid: StreamHashId | Handle | Did): Promise<{
    spaceId: StreamHashId;
    handle?: Handle;
    did?: Did;
  }>;
  checkSpaceExists(spaceId: StreamHashId): Promise<boolean>;
  createStreamHandleRecord(spaceId: StreamHashId): Promise<void>;
  removeStreamHandleRecord(): Promise<void>;
  createSpaceStream(): Promise<StreamHashId>;
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
    statementChannel: AsyncChannel<{
      sqlStatements: SqlStatement[];
      latestEvent: number;
    }>;
  } // implies leafConnected, has personalStreamId

  export interface AuthError {
    state: "error";
    error: string;
  }

  export interface ReactiveAuthenticated {
    state: "authenticated";
    did: Did;
    personalStream: StreamHashId;
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
  | ConnectionStates.LoadingPersonalStream
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

  export interface LoadingPersonalStream {
    status: "loadingPersonalStream";
    personalStream: ConnectedStream;
    eventChannel: AsyncChannel<Batch.Event>;
  }

  export interface ConnectedStreams {
    status: "connected";
    personalStream: ConnectedStream;
    eventChannel: AsyncChannel<Batch.Event>;
    streams: Map<StreamHashId, ConnectedStream>;
  }
}

export interface ConnectedStream {
  id: StreamHashId;
  pin: PinState;
}

type PinState = PinStates.Rooms | PinStates.Space;

namespace PinStates {
  export interface Rooms {
    type: "rooms";
    rooms: Map<StreamHashId, BackfillStatus>;
  }

  export interface Space {
    type: "space";
    backfill: BackfillStatus;
  }
}

export type BackfillStatus =
  | BackfillStates.Error
  | BackfillStates.Priority
  | BackfillStates.Background
  | BackfillStates.Idle;

namespace BackfillStates {
  export interface Error {
    __brand: "backfillError";
    status: "error";
    message: string;
    upToEventId?: number;
  }

  export interface Priority {
    status: "priority";
    upToEventId: number;
    completed: Deferred;
  }

  export interface Background {
    status: "background";
    upToEventId: number;
    completed: Deferred;
  }

  export interface Idle {
    status: "idle";
    upToEventId: number;
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
