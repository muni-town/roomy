import type { QueryResult } from "../sqlite/setup";
import type { Batch, StreamIndex } from "../types";
import type { BlobRef } from "@atproto/lexicon";
import { Deferred } from "$lib/utils/deferred";
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
  /**
   * Initialize the peer.
   *
   * If `oauthCallbackSearchParams` is provided, then it will create a new OAuth session using the
   * callback params.
   *
   * If `oauthCallbackSearchParams` is not provided, then it will try to restore the previous
   * session and initialize as unauthenticated if that is not possible.
   * */
  initializePeer(oauthCallbackSearchParams?: string): Promise<{ did?: string }>;
  /** Get the login redirect URL for the user with the given handle. */
  login(username: Handle): Promise<string>;
  /** Logout of the existing user session. */
  logout(): Promise<void>;

  getMembers(
    spaceDid: StreamDid,
  ): Promise<
    { did: string; handle?: string; name?: string; avatar?: string }[]
  >;
  getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined>;
  runQuery<T>(statement: SqlStatement): Promise<QueryResult<T>>;
  getProfile(did: UserDid): Promise<Profile | undefined>;
  dangerousCompletelyDestroyDatabase(opts: {
    yesIAmSure: true;
  }): Promise<{ done: true } | { done: false; error: string }>;
  ping(): Promise<{ timestamp: number }>;
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

/** A state machien that allows subscribing to state transitions. */
export type StateMachine<State extends { state: string }> = {
  /** Get the current state. */
  get current(): Readonly<State>;

  /** Set the current state. This will automatically update subscribers. */
  set current(state: State);

  /** Returns a promise that will resolve when the given state is transitioned to. */
  transitionedTo<S extends State["state"]>(
    state: S,
  ): Promise<Extract<Readonly<State>, { state: S }>>;

  /** Add a handler that will be run when the state changes. */
  subscribe(
    handler: (oldState: Readonly<State>, newState: Readonly<State>) => void,
  ): void;
};

/** An extended {@link StateMachine} that also tracks a status derived from the state. */
export type StatusMachine<
  State extends { state: string },
  Status,
> = StateMachine<State> & {
  /** Get the current status */
  get status(): Status;

  /** Register a callback to be caled with the status whenever the state changes. */
  subscribeStatus: (handler: (status: Status) => void) => void;
};

/** Create a {@link StateMachine} with the provided initial state. */
export function stateMachine<State extends { state: string }>(
  initState: State,
): StateMachine<State> {
  let state = initState;

  let subscribers: ((
    oldState: Readonly<State>,
    newState: Readonly<State>,
  ) => void)[] = [];

  // Map of deferred promises created when `transitionTo` is used to wait for a transition to a
  // specific state.
  let stateDeferreds: Map<
    State["state"],
    Deferred<Readonly<State>>
  > = new Map();

  return {
    get current() {
      return state;
    },
    set current(value) {
      const previousState = state;
      // Update the internal state
      state = value;

      // Check for a promise that might be waiting on this state transition.
      const deferred = stateDeferreds.get(state.state);
      if (deferred) {
        // Resolve the promise so that any task waiting on it is unpaused.
        deferred.resolve(state);

        // Remove it from our list of waiting promises
        stateDeferreds.delete(state.state);
      }

      // Notify all the subscribers of the state change
      for (const handler of subscribers) {
        handler(previousState, state);
      }
    },
    subscribe(handler) {
      subscribers.push(handler);
    },
    transitionedTo(desiredState) {
      type ReturnType = Promise<
        Extract<Readonly<State>, { state: typeof desiredState }>
      >;

      // If we are alredy in the desired state, resolve immediately
      if (state.state == desiredState) {
        return Promise.resolve(state) as ReturnType;
      }

      // If we already have a promise waiting on this state transition, then just return it.
      const existing = stateDeferreds.get(desiredState);
      if (existing) return existing.promise as ReturnType;

      // If we don't have a promise waiting on this state yet, create a new one.
      const deferred = new Deferred<Readonly<State>>();

      // Register it for future use
      stateDeferreds.set(desiredState, deferred);

      // And return the new promise
      const ret = deferred.promise as ReturnType;

      return ret;
    },
  };
}

/** Helper class that will track changes to the state and update a reactive status, mapping the
 * state to the status value. */
export function statusMachine<State extends { state: string }, Status>(
  trackable: TrackableState<State, Status>,
): StatusMachine<State, Status> {
  let mapper = trackable.mapper;
  let machine = stateMachine(trackable.init);

  let statusSubscribers: ((status: Status) => void)[] = [];

  // Notify any status subscribers whenever the state changes.
  machine.subscribe((_oldState, newState) => {
    const newStatus = mapper(newState);
    for (const handler of statusSubscribers) {
      handler(newStatus);
    }
  });

  return {
    get current() {
      return machine.current;
    },
    set current(value) {
      machine.current = value;
    },
    subscribe: machine.subscribe,
    transitionedTo: machine.transitionedTo,
    get status() {
      return mapper(machine.current);
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

export type SqliteState =
  | {
      state: "pending";
    }
  | {
      state: "ready";
      sqliteWorker: SqliteWorkerInterface;
    };
