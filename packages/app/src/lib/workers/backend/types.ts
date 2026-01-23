import type { QueryResult } from "../sqlite/setup";
import type { Batch, EncodedStreamEvent, StreamIndex } from "../types";
import type { Profile } from "../../types/profile";
import type { MessagePortApi } from "../workerMessaging";
import type { BlobRef } from "@atproto/lexicon";
import type { Deferred } from "$lib/utils/deferred";
import type { SqliteWorkerInterface, SqlStatement } from "../sqlite/types";
import { AsyncChannel } from "@roomy/sdk";
import type {
  StreamDid,
  UserDid,
  Event,
  Handle,
  Ulid,
  ConnectedSpace,
  RoomyClient,
} from "@roomy/sdk";
import type { SessionManager } from "@atproto/api/dist/session-manager";

export interface BackendStatus {
  authState: ReactiveAuthState;
  roomyState: ReactiveRoomyState;
  profile: Profile;
  spaces: Record<StreamDid, "loading" | "idle" | "error">;
}

export type BackendInterface = {
  getSessionId(): Promise<Ulid>;
  login(username: Handle): Promise<string>;
  logout(): Promise<void>;
  getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined>;
  initialize(searchParams?: string): Promise<{ did?: string }>;
  runQuery<T>(statement: SqlStatement): Promise<QueryResult<T>>;
  getProfile(did: UserDid): Promise<Profile | undefined>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<{ done: true } | { done: false; error: string }>;
  ping(): Promise<{ timestamp: number }>;
  clientConnected(): Promise<void>;
  enableLogForwarding(): Promise<void>;
  disableLogForwarding(): Promise<void>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  sendEvent(streamId: StreamDid, event: Event): Promise<void>;
  sendEventBatch(streamId: StreamDid, events: Event[]): Promise<void>;
  fetchEvents(
    streamId: StreamDid,
    offset: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]>;
  lazyLoadRoom(
    streamId: StreamDid,
    roomId: Ulid,
    end?: StreamIndex,
  ): Promise<void>;
  setActiveSqliteWorker(port: MessagePort): Promise<void>;
  pauseSubscription(streamId: StreamDid): Promise<void>;
  unpauseSubscription(streamId: StreamDid): Promise<void>;
  resolveHandleForSpace(spaceId: StreamDid): Promise<Handle | undefined>;
  resolveSpaceId(spaceIdOrHandle: StreamDid | Handle): Promise<{
    spaceId: StreamDid;
    handle?: Handle;
  }>;
  checkSpaceExists(spaceId: StreamDid): Promise<boolean>;
  createStreamHandleRecord(spaceId: StreamDid): Promise<void>;
  removeStreamHandleRecord(): Promise<void>;
  connectSpaceStream(spaceId: StreamDid, idx: StreamIndex): Promise<void>;
  createSpaceStream(): Promise<StreamDid>;
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
  /** Connect to all spaces accumulated during personal stream materialization.
   * Call this after sending a joinSpace event to connect to the newly joined space. */
  connectPendingSpaces(): Promise<void>;
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
  setSessionId(id: string): Promise<void>;
  initFinished(status: { userDid: string }): Promise<void>;
  log(level: ConsoleLogLevel, ...args: any[]): Promise<void>;
};

export type AuthState =
  | {
      state: "loading";
    }
  | {
      state: "unauthenticated";
    } // implies workerRunning, authLoaded
  | {
      state: "authenticated";
      session: SessionManager;
    } // implies leafConnected, has personalStreamId
  | {
      state: "error";
      error: string;
    };

export type ReactiveAuthState =
  | {
      state: "loading";
    }
  | {
      state: "unauthenticated";
    }
  | {
      state: "authenticated";
      did: UserDid;
    }
  | {
      state: "error";
      error: string;
    };

export type RoomyState =
  | {
      state: "disconnected";
    }
  | {
      state: "connectingToServer";
    }
  | {
      state: "materializingPersonalSpace";
      client: RoomyClient;
      personalSpace: ConnectedSpace;
      eventChannel: AsyncChannel<Batch.Events>;
      spaces: Map<StreamDid, ConnectedSpace>;
    }
  | {
      state: "connected";
      client: RoomyClient;
      personalSpace: ConnectedSpace;
      eventChannel: AsyncChannel<Batch.Events>;
      spaces: Map<StreamDid, ConnectedSpace>;
    }
  | {
      state: "error";
    };

export type ReactiveRoomyState =
  | {
      state: "disconnected";
    }
  | {
      state: "connectingToServer";
    }
  | {
      state: "materializingPersonalSpace";
      personalSpace: StreamDid;
    }
  | {
      state: "connected";
      personalSpace: StreamDid;
    }
  | {
      state: "error";
    };

export interface ConnectionState {
  ports: WeakMap<MessagePortApi, string>;
  count: number;
}
export interface WorkerConfig {
  consoleForwarding: boolean;
}

export type ClientStatus =
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
    personalSpace: ConnectedSpace;
    eventChannel: AsyncChannel<Batch.Events>;
    streams: Map<StreamDid, ConnectedSpace>;
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
