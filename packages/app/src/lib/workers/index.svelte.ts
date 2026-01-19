import type { Profile } from "$lib/types/profile";
import type { BlobRef } from "@atproto/lexicon";
import schemaSql from "./sqlite/schema.sql?raw";
import {
  type Ulid,
  type Handle,
  type StreamDid,
  UserDid,
  type Event,
  type StreamIndex,
  RoomyClient,
  ConnectedSpace,
  Deferred,
  AsyncChannel,
  newUlid,
} from "@roomy/sdk";
import type { BackendInterface } from "./backend/types";
import {
  createLiveQuery,
  executeQuery,
  type QueryResult,
} from "./sqlite/setup";
import type { SqliteWorkerInterface, SqlStatement } from "./sqlite/types";
import type { Batch, EncodedStreamEvent } from "./types";
import {
  BrowserOAuthClient,
  OAuthSession,
} from "@atproto/oauth-client-browser";
import { createOauthClientMetadata } from "./backend/oauth";
import { Agent } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { CONFIG } from "$lib/config";
import { SqliteWorkerSupervisor } from "./sqlite/worker";
import { messagePortInterface } from "./workerMessaging";

const LOCAL_STORAGE_SESSION_DID_KEY = "sessionDid";

const sqliteMaterializer = new SqliteWorkerSupervisor();
const sqliteChannel = new MessageChannel();
sqliteMaterializer.initialize({
  backendPort: sqliteChannel.port1,
  statusPort: new MessageChannel().port2,
  dbName: "roomy",
});
const sqlite = messagePortInterface<{}, SqliteWorkerInterface>(
  sqliteChannel.port2,
  {},
);

/** The stream of events that we we need to materialize. */
const eventsToMaterialize = new AsyncChannel<Batch.Events>();

/** Start materializing events that come over the `eventsToMaterialize` stream. */
async function startMaterializer() {
  for await (const batch of eventsToMaterialize) {
    console.warn('sending batch', batch);
    sqlite.materializeBatch(batch, "priority");
  }
}
startMaterializer();

// Compose type for backend status
type BackendStatusAuth =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "unauthenticated" }
  | { state: "authenticated"; did: UserDid; session: OAuthSession }
  | { state: "error"; error: Error | string };
type BackendStatusRoomy =
  | { state: "disconnected" }
  | { state: "connectingToServer" }
  | { state: "connectingPersonalSpace" }
  | { state: "connected"; personalSpace: ConnectedSpace; client: RoomyClient };
type BackendStatus = {
  auth: BackendStatusAuth;
  roomy: BackendStatusRoomy;
  profile?: Profile;
  spaces: Record<StreamDid, "loading" | "idle" | "error">;
};

const clientConnected = new Deferred();

/** Create reactive global containing the backend status. */
export const backendStatus: BackendStatus = $state({
  auth: { state: "disconnected" },
  roomy: { state: "disconnected" },
  profile: undefined,
  spaces: {},
});

// Expose in console for development
(globalThis as any).backendStatus = backendStatus;

// Create an oauth client to use for logging in and establishing session.
const oauth = createOauthClientMetadata().then(
  // NOTE: we'd rather await right here instead of store a promise, but top-level await is a no-no on
  // Webkit.
  (clientMetadata) =>
    new BrowserOAuthClient({
      handleResolver: "https://resolver.roomy.chat",
      responseMode: "query",
      clientMetadata,
    }),
);

/**
 * Authenticate the backend, restoring the previous session if possible, or initializing a new
 * session from the OAuth callback search params if supplied.
 * */
async function connectBackend(): Promise<{ did?: string }>;
async function connectBackend(
  oauthCallbackSearchParams: string,
): Promise<{ did: string }>;
async function connectBackend(
  oauthCallbackSearchParams?: string,
): Promise<{ did?: string }> {
  console.info("Authenticating backend");

  // Start connecting auth
  backendStatus.auth = { state: "connecting" };

  if (oauthCallbackSearchParams) {
    // Create new session from OAuth callback
    console.info("Creating new session from callback");

    // Parse URL query prameters
    const params = new URLSearchParams(oauthCallbackSearchParams);

    try {
      // Create session
      const { session } = await (await oauth).callback(params);

      // Record session DID so we can try to restore it later
      localStorage.setItem(LOCAL_STORAGE_SESSION_DID_KEY, session.did);

      console.info("Created new session", { did: session.did });

      // We are now authenticated
      backendStatus.auth = {
        state: "authenticated",
        did: UserDid.assert(session.did),
        session,
      };

      // Authenticate the backend with the session
      await connectUsingSession(session);

      return { did: session.did };
    } catch (e: any) {
      backendStatus.auth = { state: "error", error: e };
      throw e;
    }
  } else {
    // Try to restore previous session if we do not have oauth callback search params

    // Check for previous session DID
    const sessionDid = localStorage.getItem(LOCAL_STORAGE_SESSION_DID_KEY);

    // If we don't have a previous session DID, then we are unauthenticated
    if (!sessionDid) {
      console.info("No previous session: we are unauthenticated");
      backendStatus.auth = { state: "unauthenticated" };
      return {};
    }

    console.info("Trying to restore previous session");

    try {
      // Attempt to restore the previous session
      const session = await (await oauth).restore(sessionDid, true);

      console.info("Restored previous session", { did: session.did });

      // We are now authenticated
      backendStatus.auth = {
        state: "authenticated",
        did: UserDid.assert(session.did),
        session,
      };

      // Authenticate the backend with the session
      await connectUsingSession(session);

      return { did: session.did };
    } catch (e) {
      // We don't actually want to go to a backend error state here, because it would just show in
      // the UI and there's nothing to do about it, so just log it and refresh the page.
      console.warn("Could not restore previous session", e);
      localStorage.removeItem(LOCAL_STORAGE_SESSION_DID_KEY);
      window.location.href = "/";
    }

    return {};
  }

  /** Use the authenticated session to connect to the Roomy server  */
  async function connectUsingSession(session: OAuthSession) {
    console.info("Connecting to Roomy server");
    backendStatus.roomy = { state: "connectingToServer" };

    // Create the ATProto agent from the session
    const agent = new Agent(session);
    // Load the lexicons we will need
    lexicons.forEach((l) => agent.lex.add(l));

    // Create the Roomy client
    const client = await RoomyClient.create({
      agent,
      leafUrl: CONFIG.leafUrl,
      leafDid: CONFIG.leafServerDid,
      spaceHandleNsid: CONFIG.streamHandleNsid,
      spaceNsid: CONFIG.streamNsid,
    });

    // Fetch the user profile asynchronously
    fetchProfile(client);

    console.info("Connecting to personal space");
    backendStatus.roomy = { state: "connectingPersonalSpace" };

    // Open connection to personal space
    const personalSpace = await client.connectPersonalSpace(
      CONFIG.streamSchemaVersion,
    );

    // Subscribe to materialize personal stream events
    personalSpace.subscribe((events) => {
      if (events.length > 0) {
        eventsToMaterialize.push({
          status: "events",
          batchId: newUlid(),
          events,
          priority: "priority",
          streamId: personalSpace.streamDid,
        });
      }
    });

    console.info("Connected to Personal Space", {
      streamDid: personalSpace.streamDid,
    });

    // Finish the roomy initialization span
    globalInitSpan.end();

    // We are connected
    backendStatus.roomy = { state: "connected", personalSpace, client };
    clientConnected.resolve();
  }

  /** Fetch user profile and update backend status. */
  async function fetchProfile(roomy: RoomyClient) {
    await roomy
      .getProfile(UserDid.assert(roomy.agent.assertDid))
      .then((profile) => {
        backendStatus.profile = profile;
      });
  }
}

connectBackend();

/** Get the ID of the authenticated user's personal space */
export function getPersonalSpaceId() {
  return backendStatus.roomy?.state === "connected"
    ? backendStatus.roomy.personalSpace.streamDid
    : undefined;
}

export const backend: BackendInterface = {
  getSessionId: function (): Promise<Ulid> {
    throw new Error("Function not implemented.");
  },
  login: async function (handle: Handle): Promise<string> {
    // Calculate login redirect URI
    const { href } = await (await oauth).authorize(handle);
    return href;
  },
  logout: async function (): Promise<void> {
    if (backendStatus.auth.state == "authenticated") {
      localStorage.removeItem(LOCAL_STORAGE_SESSION_DID_KEY);
      await backendStatus.auth.session.signOut();
      // Intentionally reload the page in order to clear any left-over state
      window.location.href = "/";
    }
  },
  getSpaceInfo: function (
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined> {
    if (backendStatus.roomy.state != "connected")
      throw new Error("Roomy client not connected");
    return backendStatus.roomy.client.getSpaceInfo(streamDid);
  },
  oauthCallback: function (
    oauthCallbackSearchParams: string,
  ): Promise<{ did: string }> {
    return connectBackend(oauthCallbackSearchParams);
  },
  runQuery: function <T>(statement: SqlStatement): Promise<QueryResult<T>> {
    return Promise.resolve(executeQuery(statement));
  },
  getProfile: function (did: UserDid): Promise<Profile | undefined> {
    if (backendStatus.roomy.state != "connected")
      throw new Error("Roomy client not connected");
    return backendStatus.roomy.client.getProfile(did);
  },
  dangerousCompletelyDestroyDatabase: function (_opts: {
    yesIAmSure: true;
  }): Promise<{ done: true } | { done: false; error: string }> {
    throw new Error("Not implemented");
  },
  ping: function (): Promise<{ timestamp: number }> {
    return Promise.resolve({ timestamp: Date.now() });
  },
  clientConnected: function (): Promise<void> {
    return clientConnected.promise;
  },
  enableLogForwarding: function (): Promise<void> {
    throw new Error("Function not implemented.");
  },
  disableLogForwarding: function (): Promise<void> {
    throw new Error("Function not implemented.");
  },
  createLiveQuery: function (
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void> {
    return createLiveQuery(id, port, statement);
  },
  sendEvent: function (streamDid: StreamDid, event: Event): Promise<void> {
    if (backendStatus.roomy.state != "connected")
      throw new Error("Roomy client not connected");
    return backendStatus.roomy.client.sendEvent(streamDid, event);
  },
  sendEventBatch: function (
    streamDid: StreamDid,
    events: Event[],
  ): Promise<void> {
    if (backendStatus.roomy.state != "connected")
      throw new Error("Roomy client not connected");
    return backendStatus.roomy.client.sendEvents(streamDid, events);
  },
  fetchEvents: function (
    _streamId: StreamDid,
    _offset: number,
    _limit: number,
  ): Promise<EncodedStreamEvent[]> {
    throw new Error("Not implemented");
  },
  lazyLoadRoom: function (
    streamId: StreamDid,
    roomId: Ulid,
    end?: StreamIndex,
  ): Promise<void> {
    throw new Error("Function not implemented.");
  },
  setActiveSqliteWorker: function (port: MessagePort): Promise<void> {
    throw new Error("Function not implemented.");
  },
  pauseSubscription: function (streamId: StreamDid): Promise<void> {
    throw new Error("Function not implemented.");
  },
  unpauseSubscription: function (streamId: StreamDid): Promise<void> {
    throw new Error("Function not implemented.");
  },
  resolveHandleForSpace: function (
    spaceId: StreamDid,
    handleAccountDid: UserDid,
  ): Promise<Handle | undefined> {
    throw new Error("Function not implemented.");
  },
  resolveSpaceId: function (
    spaceIdOrHandle: StreamDid | Handle,
  ): Promise<{ spaceId: StreamDid; handle?: Handle; did?: UserDid }> {
    throw new Error("Function not implemented.");
  },
  checkSpaceExists: function (spaceId: StreamDid): Promise<boolean> {
    throw new Error("Function not implemented.");
  },
  createStreamHandleRecord: function (spaceId: StreamDid): Promise<void> {
    throw new Error("Function not implemented.");
  },
  removeStreamHandleRecord: function (): Promise<void> {
    throw new Error("Function not implemented.");
  },
  connectSpaceStream: function (
    spaceId: StreamDid,
    idx: StreamIndex,
  ): Promise<void> {
    throw new Error("Function not implemented.");
  },
  createSpaceStream: function (): Promise<StreamDid> {
    throw new Error("Function not implemented.");
  },
  getStreamRecord: function (): Promise<{ id: string } | null> {
    throw new Error("Function not implemented.");
  },
  deleteStreamRecord: function (): Promise<void> {
    throw new Error("Function not implemented.");
  },
  ensurePersonalStream: function (): Promise<void> {
    throw new Error("Function not implemented.");
  },
  uploadToPds: function (
    bytes: ArrayBuffer,
    opts?: { alt?: string; mimetype?: string },
  ): Promise<{ blob: ReturnType<BlobRef["toJSON"]>; uri: string }> {
    throw new Error("Function not implemented.");
  },
  addClient: function (port: MessagePort): Promise<void> {
    throw new Error("Function not implemented.");
  },
};
