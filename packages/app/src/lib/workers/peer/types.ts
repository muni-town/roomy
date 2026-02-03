import type { QueryResult } from "../sqlite/setup";
import type { Batch, StreamIndex } from "../types";
import type { BlobRef } from "@atproto/lexicon";
import type { Deferred } from "$lib/utils/deferred";
import type { SqliteWorkerInterface, SqlStatement } from "../sqlite/types";
import { AsyncChannel } from "@roomy/sdk";
import {
  type Profile,
  type StreamDid,
  UserDid,
  type Event,
  type Handle,
  type Ulid,
  type ConnectedSpace,
  type RoomyClient,
  type DecodedStreamEvent,
  type EncodedStreamEvent,
} from "@roomy/sdk";
import type { SessionManager } from "@atproto/api/dist/session-manager";
import type { messagePortInterface } from "../internalMessaging";

export interface PeerStatus {
  authState: AuthStatus;
  roomyState: RoomyStatus;
  profile: Profile;
  spaces: Record<StreamDid, "loading" | "idle" | "error">;
}

/** RPC interface exposed by the peer to its clients. */
export type PeerInterface = {
  getSessionId(): Promise<Ulid>;
  login(username: Handle): Promise<string>;
  logout(): Promise<void>;
  getMembers(
    spaceDid: StreamDid,
  ): Promise<
    { did: string; handle?: string; name?: string; avatar?: string }[]
  >;
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
  ): Promise<{ hasMore: boolean }>;
  fetchLinks(
    streamId: StreamDid,
    start: StreamIndex,
    limit: number,
    room?: Ulid,
  ): Promise<DecodedStreamEvent[]>;
  setActiveSqliteWorker(port: MessagePort): Promise<void>;
  pauseSubscription(streamId: StreamDid): Promise<void>;
  unpauseSubscription(streamId: StreamDid): Promise<void>;
  resolveHandleForSpace(spaceId: StreamDid): Promise<Handle | undefined>;
  resolveSpaceId(spaceIdOrHandle: StreamDid | Handle): Promise<{
    spaceId: StreamDid;
    handle?: Handle;
  }>;
  checkSpaceExists(spaceId: StreamDid): Promise<boolean>;
  setProfileSpace(spaceId: StreamDid | null): Promise<void>;
  getProfileSpace(): Promise<StreamDid | undefined>;
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
  /**
   * Connect an RPC client to the peer over the provided message port.
   *
   * The client will be able to call the {@link PeerInterface} on the port using the
   * {@link messagePortInterface} and the {@link Peer} will be able to call the the
   * {@link PeerClientInterface} on the client.
   */
  connectRpcClient(port: MessagePort): Promise<void>;
  /** Connect to all spaces accumulated during personal stream materialization.
   * Call this after sending a joinSpace event to connect to the newly joined space. */
  connectPendingSpaces(): Promise<void>;
  setSpaceHandle(spaceDid: StreamDid, handle: string | null): Promise<void>;
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

/** RPC interface exposed by peer clients to the peer. */
export type PeerClientInterface = {
  /** This is called to give the peer client the session ID of the connected peer. */
  setSessionId(id: string): Promise<void>;

  /**
   * Signal that the peer initialization has been finshed.
   *
   * If the peer has already been initialized and a new peer client connects, then this will be sent
   * to it immediately after it connects.
   */
  initFinished(status: { userDid: string }): Promise<void>;

  /**
   * This may be called by the peer to log a message on the peer client's console.
   *
   * It is useful when the peer is in a shared worker and wants to propagate logs to the peer client
   * for ease of access.
   */
  log(level: ConsoleLogLevel, ...args: any[]): Promise<void>;
};

export type TrackableState<State, Status> = {
  init: State;
  mapper: (state: State) => Status;
};
const trackableState = <State, Status>(
  init: State,
  mapper: (state: State) => Status,
): TrackableState<State, Status> => ({
  init,
  mapper,
});

export type TrackedState<State, Status> = {
  get current(): Readonly<State>;
  set current(state: State);
  get status(): Status;
  subscribeStatus: (handler: (status: Status) => void) => void;
};

/** Helper class that will track changes to the state and update a reactive status, mapping the
 * state to the status value. */
export function trackedState<State, Status>(
  trackable: TrackableState<State, Status>,
): TrackedState<State, Status> {
  let state = trackable.init;
  let mapper = trackable.mapper;

  let statusSubscribers: ((status: Status) => void)[] = [];

  return {
    get current() {
      return state;
    },
    set current(value) {
      // Update the internal state
      state = value;

      // Notify status subscribers
      const status = mapper(state);
      for (const handler of statusSubscribers) {
        handler(status);
      }
    },

    get status() {
      return mapper(state);
    },

    subscribeStatus(handler: (status: Status) => void) {
      statusSubscribers.push(handler);
    },
  };
}

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

export type AuthStatus =
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
export const authStateTrackable = trackableState<AuthState, AuthStatus>(
  { state: "loading" },
  (value) => {
    if (
      value.state == "loading" ||
      value.state == "error" ||
      value.state == "unauthenticated"
    ) {
      return value;
    } else if (value.state == "authenticated") {
      return {
        state: "authenticated",
        did: UserDid.assert(value.session.did),
      };
    } else {
      throw "Unexpected state";
    }
  },
);

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

export type RoomyStatus =
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

export const roomyStateTrackable = trackableState<RoomyState, RoomyStatus>(
  { state: "disconnected" },
  (value) => {
    if (
      value.state == "disconnected" ||
      value.state == "error" ||
      value.state == "connectingToServer"
    ) {
      return value;
    } else if (value.state == "materializingPersonalSpace") {
      return {
        state: "materializingPersonalSpace",
        personalSpace: value.personalSpace.streamDid,
      };
    } else if (value.state == "connected") {
      return {
        state: "connected",
        personalSpace: value.personalSpace.streamDid,
      };
    } else {
      throw "Unexpected state";
    }
  },
);

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
