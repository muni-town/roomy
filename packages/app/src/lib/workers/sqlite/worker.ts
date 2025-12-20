/* eslint-disable @typescript-eslint/no-empty-object-type */
import {
  type ApplyResultError,
  type Batch,
  type Bundle,
  type StreamIndex,
  type TaskPriority,
} from "../types";
import {
  initializeDatabase,
  executeQuery,
  deleteLiveQuery,
  createLiveQuery,
  disableLiveQueries,
  enableLiveQueries,
  getVfsType,
  type QueryResult,
} from "./setup";
import { messagePortInterface, reactiveWorkerState } from "../workerMessaging";
import { db } from "../idb";
import schemaSql from "./schema.sql?raw";
import { sql } from "$lib/utils/sqlTemplate";
import { StreamDid, UserDid, parseEvent } from "$lib/schema";
import { materialize } from "./materializer";
import { AsyncChannel } from "../asyncChannel";
import type {
  Savepoint,
  SqliteStatus,
  SqliteWorkerInterface,
  SqlStatement,
} from "./types";
import type { BackendInterface } from "../backend/types";
import { Deferred } from "$lib/utils/deferred";
import { CONFIG } from "$lib/config";
// import { initializeFaro } from "$lib/otel";
import { decode } from "@atcute/cbor";

let faro;
try {
  // TODO: parameterize enabling faro
  // faro = initializeFaro({ worker: "sqlite" });
  // faro.api
  //   .getOTEL()!
  //   .trace.getTracer("roomy-worker", __APP_VERSION__)
  //   .startActiveSpan("sqlite span", (span) => {
  //     span.setAttribute("hello", "world");
  //     console.info("Tracing!!!");
  //     span.end();
  //   });
} catch (e) {
  console.error("Failed to initialize Faro in sqlite worker", e);
}

console.info("Started sqlite worker", { test: 3 });

const initSql = schemaSql
  .split("\n")
  .filter((x) => !x.startsWith("--"))
  .join("\n")
  .split(";\n\n")
  .filter((x) => !!x.replace("\n", ""))
  .map((sql) => ({ sql }));
const QUERY_LOCK = "sqliteQueryLock";
const HEARTBEAT_KEY = "sqlite-worker-heartbeat";
const LOCK_TIMEOUT_MS = 8000; // 30 seconds
const newUserSignals = [
  "space.roomy.room.sendMessage.v0",
  "space.roomy.room.sendMessage.v1",
  "space.roomy.room.joinRoom.v0",
];

class SqliteWorkerSupervisor {
  // Private state
  #workerId: string;
  #isConnectionHealthy: boolean = true;
  // Heartbeat mechanism to prove this worker is alive
  #heartbeatInterval: NodeJS.Timeout | null = null;
  #status: Partial<SqliteStatus> = {};
  #backend: BackendInterface | null = null;
  #ensuredProfiles = new Set<string>();
  #knownStreams = new Set<StreamDid>();
  #eventChannel: AsyncChannel<Batch.Events>;
  #statementChannel = new AsyncChannel<Batch.Statement>();
  #resultChannel = new AsyncChannel<Batch.ApplyResult>();
  #pendingBatches = new Map<string, (result: Batch.ApplyResult) => void>();
  #authenticated = new Deferred();

  constructor() {
    this.#workerId = crypto.randomUUID();
    this.#eventChannel = new AsyncChannel();
  }

  initialize(params: {
    backendPort: MessagePort;
    statusPort: MessagePort;
    dbName: string;
  }) {
    // Monitor port health
    params.backendPort.onmessageerror = (error) => {
      console.error("SQLite worker: Backend port message error", error);
      this.#isConnectionHealthy = false;
    };

    params.statusPort.onmessageerror = (error) => {
      console.error("SQLite worker: Status port message error", error);
      this.#isConnectionHealthy = false;
    };

    this.#status = reactiveWorkerState<SqliteStatus>(params.statusPort, true);

    this.#backend = messagePortInterface<{}, BackendInterface>(
      params.backendPort,
      {},
    );

    this.#status.workerId = this.#workerId;
    this.#status.isActiveWorker = false; // Initialize to false for reactive state tracking
    this.#status.vfsType = undefined; // Will be set after database initialization
    console.info("SQLite Worker id", this.#workerId, "dbName", params.dbName);

    // initially load only in-memory
    this.loadDb(params.dbName, false).then(() => {
      try {
        const sqliteChannel = new MessageChannel();
        messagePortInterface<SqliteWorkerInterface, {}>(
          sqliteChannel.port1,
          this.getSqliteInterface(),
        );
        this.#backend?.setActiveSqliteWorker(sqliteChannel.port2);
        this.materializer();
        this.listenStatements();
        this.listenResults();
        console.log("Finished initialising SQLite Worker", this.#status);
      } catch (error) {
        console.error("SQLite worker initialisation: Fatal error", error);
        this.cleanup();
        throw error;
      }
    });
  }

  private async loadDb(dbName: string, persistent: boolean) {
    console.log("Calling loadDb with dbName", dbName);

    const deferred = new Deferred<void>();

    const callback = async () => {
      console.log(
        "Sqlite worker lock obtained: Active worker id:",
        this.#workerId,
      );
      this.#status.isActiveWorker = true;
      this.startHeartbeat();

      globalThis.addEventListener("error", this.cleanup);
      globalThis.addEventListener("unhandledrejection", this.cleanup);

      try {
        await initializeDatabase(dbName, persistent);

        this.#status.vfsType = getVfsType() || undefined;
        console.log(
          "SQLite Worker",
          dbName,
          "using VFS:",
          this.#status.vfsType,
        );

        // initialise DB schema (should be idempotent)
        console.time("initSql");
        await this.runSavepoint({ name: "init", items: initSql });
        console.timeEnd("initSql");

        // Set current schema version
        await executeQuery(sql`
          insert or replace into roomy_schema_version
          (id, version) values (1, ${CONFIG.databaseSchemaVersion})
          `);

        deferred.resolve();
      } catch (e) {
        console.error("SQLite worker loadDb: Fatal error", e);
        this.cleanup();
        deferred.reject(e);
        throw e;
      }
    };

    const attemptLock = async (): Promise<void> => {
      try {
        await navigator.locks.request(
          "sqlite-worker-lock",
          { mode: "exclusive", signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
          callback,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          console.warn("SQLite worker: Lock timeout, attempting steal");
          await this.attemptLockSteal(callback);
          // If lock steal didn't succeed, try again
          if (!deferred.promise) {
            await attemptLock();
          }
        } else {
          deferred.reject(error);
          throw error;
        }
      }
    };

    attemptLock();
    return deferred.promise;
  }

  listenStatements() {
    (async () => {
      for await (const batch of this.#statementChannel) {
        // apply statements
        try {
          const result = await this.runStatementBatch(batch);
          console.log(
            "Ran statements, got result",
            result,
            "pushing to resultChannel",
          );
          this.#resultChannel.push(result);

          // Connect spaces AFTER batch is applied and committed
          if (batch.spacesToConnect && batch.spacesToConnect.length > 0) {
            console.log(
              `Connecting ${batch.spacesToConnect.length} space(s) after batch commit:`,
              batch.spacesToConnect,
            );
            for (const spaceId of batch.spacesToConnect) {
              this.connectSpaceStream(spaceId);
            }
          }
        } catch (error) {
          console.error("Error running statement batch", batch, error);
        }
      }
    })();
  }

  listenResults() {
    (async () => {
      for await (const batch of this.#resultChannel) {
        console.log("Got result", batch, "trying to resolve");
        // resolve promises
        try {
          const resolver = this.#pendingBatches.get(batch.batchId);
          if (resolver) {
            resolver(batch);
            this.#pendingBatches.delete(batch.batchId);
          } else {
            throw new Error("Lost the resolver 😬");
          }
        } catch (error) {
          console.error("Error running statement batch", batch, error);
        }
      }
    })();
  }

  private cleanup() {
    console.log("SQLite worker: Cleaning up...");
    this.stopHeartbeat();
    this.#status.isActiveWorker = false;
    this.#eventChannel.finish();
    this.#statementChannel.finish();
    this.#resultChannel.finish();

    // Clear our heartbeat

    db.kv
      .get(HEARTBEAT_KEY)
      .then((heartbeatData) => {
        if (heartbeatData) {
          const { workerId: storedWorkerId } = JSON.parse(heartbeatData.value);
          if (storedWorkerId === this.#workerId) {
            db.kv.delete(HEARTBEAT_KEY);
          }
        }
      })
      .catch((e) =>
        console.warn("SQLite worker: Failed to clear heartbeat on cleanup", e),
      );
  }

  private startHeartbeat() {
    if (this.#heartbeatInterval) clearInterval(this.#heartbeatInterval);

    this.#heartbeatInterval = setInterval(() => {
      // Store heartbeat with current timestamp
      try {
        db.kv.put({
          key: HEARTBEAT_KEY,
          value: JSON.stringify({
            workerId: this.#workerId,
            timestamp: Date.now(),
          }),
        });
      } catch (e) {
        console.warn("SQLite worker: Failed to update heartbeat", e);
      }
    }, 5000); // Update every 5 seconds
  }

  private stopHeartbeat() {
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
  }

  private async attemptLockSteal(callback: () => Promise<void>) {
    try {
      // Check if there's a recent heartbeat from another worker
      const heartbeatData = await db.kv.get(HEARTBEAT_KEY);
      if (heartbeatData) {
        const { timestamp, workerId: otherWorkerId } = JSON.parse(
          heartbeatData.value,
        );
        const age = Date.now() - timestamp;

        if (age < LOCK_TIMEOUT_MS && otherWorkerId !== this.#workerId) {
          console.log(
            "SQLite worker: Another active worker detected, backing off",
          );
          return;
        }
      }

      console.log(
        "SQLite worker: No recent heartbeat detected, attempting to acquire lock",
      );

      // Try to acquire lock with ifAvailable first
      const lockAcquired = await navigator.locks.request(
        "sqlite-worker-lock-backup",
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return false;

          console.log("SQLite worker: Successfully stole abandoned lock");
          await callback();
          return true;
        },
      );

      if (!lockAcquired) {
        console.warn(
          "SQLite worker: Could not steal lock, another worker may be active",
        );
      }
    } catch (error) {
      console.error("SQLite worker: Lock steal attempt failed", error);
    }
  }

  private getSqliteInterface(): SqliteWorkerInterface {
    return {
      authenticate: async (did) => {
        await this.loadDb(did, false);
        this.#status.authenticated = did;
        this.#authenticated.resolve();
        console.log("✅ Authenticated SQLite Worker with did:", did);
      },
      materializeBatch: async (eventsBatch, priority) => {
        return this.materializeBatch(eventsBatch, priority);
      },
      runQuery: async <Row>(statement: SqlStatement) => {
        // This lock makes sure that the JS tasks don't interleave some other query executions in while we
        // are trying to compose a bulk transaction.
        return navigator.locks.request(QUERY_LOCK, async () => {
          try {
            return (await executeQuery(statement)) as QueryResult<Row>;
          } catch (e) {
            throw new Error(
              `Error running SQL query \`${statement.sql}\`: ${e}`,
            );
          }
        });
      },
      createLiveQuery: async (id, port, statement) => {
        await this.#authenticated.promise;
        if (!this.#status.authenticated) throw new Error("Not authenticated");
        createLiveQuery(id, port, statement);
      },
      deleteLiveQuery: async (id) => {
        await this.#authenticated.promise;
        if (!this.#status.authenticated) throw new Error("Not authenticated");
        deleteLiveQuery(id);
      },
      ping: async () => {
        console.log("SQLite worker: Ping received");

        // Check lock status
        const lockInfo = await navigator.locks.query();
        const sqliteLocks = lockInfo?.held?.filter(
          (lock) =>
            lock.name === "sqlite-worker-lock" || lock.name === QUERY_LOCK,
        );

        if (!this.#isConnectionHealthy) {
          console.warn("SQLite worker: Connection is unhealthy.");
        }
        if (!this.#isConnectionHealthy) {
          console.warn("SQLite worker: Connection is unhealthy.");
        }
        return {
          timestamp: Date.now(),
          workerId: this.#workerId,
          isActive: this.#status.isActiveWorker || false,
          locks: sqliteLocks,
          locksPending: lockInfo?.pending?.filter(
            (lock) =>
              lock.name === "sqlite-worker-lock" || lock.name === QUERY_LOCK,
          ),
        };
      },
      runSavepoint: async (savepoint) => {
        if (!this.#status.authenticated) throw new Error("Not authenticated");
        return this.runSavepoint(savepoint);
      },
    };
  }

  private async runStatementBatch(batch: Batch.Statement) {
    const exec = async () => {
      await executeQuery({ sql: `savepoint batch${batch.batchId}` });

      const results: Batch.ApplyResult["results"] = [];

      for (const bundle of batch.bundles) {
        if (bundle.status === "success") {
          results.push(await this.runStatementBundle(bundle, batch.streamId));
        } else if (bundle.status === "profiles") {
          results.push(await this.runStatementProfileBundle(bundle));
        }
      }

      await executeQuery(
        sql`update comp_space set backfilled_to = ${batch.latestEvent} where entity = ${batch.streamId}`,
      );

      console.log("Updated backfilled_to to", batch.latestEvent);

      await executeQuery({ sql: `release batch${batch.batchId}` });
      return {
        batchId: batch.batchId,
        priority: batch.priority,
        status: "applied",
        results,
      } as const;
    };

    disableLiveQueries();

    // This lock makes sure that the JS tasks don't interleave some other query executions in while we
    // are trying to compose a bulk transaction.
    const result: Batch.ApplyResult = await navigator.locks.request(
      QUERY_LOCK,
      exec,
    );

    await enableLiveQueries();

    return result;
  }

  private async runBundleStatements(
    bundleId: string,
    statements: SqlStatement[],
    eventMeta?: {
      streamId: StreamDid;
      idx: StreamIndex;
    },
  ) {
    await executeQuery({ sql: `savepoint bundle${bundleId}` });
    const queryResults: (QueryResult | ApplyResultError)[] = [];
    let hadError = false;
    for (const statement of statements) {
      try {
        queryResults.push(await executeQuery(statement));
      } catch (e) {
        hadError = true;
        console.warn(
          `Error executing individual statement in savepoint bundle${bundleId}:`,
          e,
        );
        if (statement && "sql" in statement) {
          console.warn(`Failed SQL:`, statement.sql);
          console.warn(`Failed params:`, statement.params);
        }
        queryResults.push({
          type: "error",
          statement,
          message: e instanceof Error ? e.message : (e as string),
        });
      }
    }

    if (eventMeta && !hadError) {
      const updateEvent = sql`
        update events set applied = 1
        where stream_id = ${eventMeta.streamId}
          and
        idx = ${eventMeta.idx}
        `;
      queryResults.push(
        await executeQuery(updateEvent).catch((e) => {
          return {
            type: "error",
            statement: updateEvent,
            message: e instanceof Error ? e.message : (e as string),
          };
        }),
      );
    }

    await executeQuery({ sql: `release bundle${bundleId}` });
    return queryResults;
  }

  private async runStatementProfileBundle(
    bundle: Bundle.StatementProfile,
  ): Promise<Bundle.ProfileApplyResult> {
    const bundleId = bundle.dids[0]?.replaceAll(":", "");
    const queryResults = bundleId
      ? await this.runBundleStatements(bundleId, bundle.statements)
      : [];

    return {
      result: "appliedProfiles",
      firstDid: bundle.dids[0],
      output: queryResults,
    };
  }

  private async runStatementBundle(
    bundle: Bundle.StatementSuccess,
    streamId: StreamDid,
  ): Promise<Bundle.ApplyResult> {
    const bundleId = bundle.eventId;

    // TODO: check if we have the bundle.dependsOn event, and run the statements only if we do, otherwise stash

    const queryResults = await this.runBundleStatements(
      bundleId,
      bundle.statements,
      { streamId, idx: bundle.eventIdx },
    );

    return {
      result: "applied",
      eventId: bundle.eventId,
      output: queryResults,
    };
  }

  private async runSavepoint(savepoint: Savepoint, depth = 0) {
    const exec: () => Promise<QueryResult[]> = async () => {
      await executeQuery({ sql: `savepoint ${savepoint.name}` });
      let hadError = false;
      const queryResults: QueryResult[] = [];
      for (const savepointOrStatement of savepoint.items) {
        try {
          if ("sql" in savepointOrStatement) {
            queryResults.push(await executeQuery(savepointOrStatement));
          } else {
            queryResults.concat(
              await this.runSavepoint(savepointOrStatement, depth + 1),
            );
          }
        } catch (e) {
          // Log the error but continue executing other statements
          console.warn(
            `Error executing individual statement in savepoint ${savepoint.name}:`,
            e,
          );
          if (savepointOrStatement && "sql" in savepointOrStatement) {
            console.warn(`Failed SQL:`, savepointOrStatement.sql);
            console.warn(`Failed params:`, savepointOrStatement.params);
          }
          hadError = true;
        }
      }

      if (hadError) {
        console.warn(
          `Savepoint ${savepoint.name} completed with ${hadError ? "errors" : "no errors"}`,
        );
      }

      await executeQuery({ sql: `release ${savepoint.name}` });
      return queryResults;
    };

    if (depth == 0) {
      console.log("runSavepoint", savepoint);
      disableLiveQueries();

      // This lock makes sure that the JS tasks don't interleave some other query executions in while we
      // are trying to compose a bulk transaction.
      const result = await navigator.locks.request(QUERY_LOCK, exec);

      await enableLiveQueries();
      return result;
    } else {
      return exec();
    }
  }

  async connectSpaceStream(spaceId: StreamDid) {
    const knownStream = this.#knownStreams.has(spaceId);
    if (!knownStream) {
      const maybeSpace = await executeQuery(sql`
        select backfilled_to, hidden from comp_space 
        where entity = ${spaceId}`);

      const backfilledToIdx = (
        maybeSpace.rows?.length ? maybeSpace.rows[0]!.backfilled_to : 0
      ) as StreamIndex;

      this.#knownStreams.add(spaceId);
      await this.#backend?.connectSpaceStream(spaceId, backfilledToIdx);
    }
  }

  /** Map a batch of incoming events to SQL that applies the event to the entities,
   * components and edges, then execute them all as a single transaction.
   */
  materializer() {
    (async () => {
      for await (const batch of this.#eventChannel) {
        const bundles: Bundle.Statement[] = [];

        console.time("convert-events-to-sql");

        // reset ensured flags for each new batch
        this.#ensuredProfiles = new Set();

        const decodedEvents = batch.events
          .map((e) => {
            try {
              // Convert ArrayBuffer to Uint8Array for decoding
              const payloadBytes = new Uint8Array(e.payload);
              const decoded = decode(payloadBytes);
              const result = parseEvent(decoded);
              if (result.success) {
                return [e, result.data] as const;
              } else throw result.error;
            } catch (error) {
              const payloadBytes = new Uint8Array(e.payload);
              console.warn(
                `Skipping malformed event (idx ${e.idx}): Failed to decode ${payloadBytes.length} bytes.`,
                `Error:`,
                error instanceof Error ? error.message : error,
              );
              // Return null to filter out this event
              return null;
            }
          })
          .filter((e): e is Exclude<typeof e, null> => e !== null);

        // Make sure all of the profiles we need are downloaded and inserted
        const neededProfiles = new Set<UserDid>();
        decodedEvents.forEach(([i, ev]) =>
          newUserSignals.includes(ev.variant.$type)
            ? UserDid.allows(i.user)
              ? neededProfiles.add(UserDid.assert(i.user))
              : console.warn("Found invalid user id", i.user)
            : undefined,
        );

        bundles.push(await this.ensureProfiles(batch.streamId, neededProfiles));

        let latestEvent = 0;
        const spacesToConnect: StreamDid[] = [];
        for (const [incoming, event] of decodedEvents) {
          latestEvent = Math.max(latestEvent, incoming.idx);
          try {
            // Get the SQL statements to be executed for this event
            const bundle: Bundle.Statement = await materialize(
              event,
              {
                streamId: batch.streamId,
                user: incoming.user,
              },
              incoming.idx,
            );

            bundles.push(bundle);

            if (bundle.status === "success") {
              // Collect space IDs to connect AFTER batch is applied
              if (event.variant.$type === "space.roomy.personal.joinSpace.v0") {
                spacesToConnect.push(event.variant.spaceId);
              }
            }
          } catch (e) {
            console.warn("Event materialisation failed: " + e);
          }
        }

        console.log(
          "materialised bundles",
          bundles,
          "for batch id",
          batch.batchId,
          "awaiting application",
        );

        this.#statementChannel.push(
          {
            status: "transformed",
            batchId: batch.batchId,
            streamId: batch.streamId,
            bundles: bundles,
            latestEvent: latestEvent as StreamIndex,
            priority: batch.priority,
            spacesToConnect,
          },
          batch.priority,
        );
        console.timeEnd("convert-events-to-sql");
      }
    })();
  }

  /** When mapping incoming events to SQL, 'ensureProfiles' checks whether a DID
   * exists in the profiles table. If not, it makes an API call to bsky to get some
   * basic info, and then returns SQL to add it to the profiles table. Rather than
   * inserting it immediately and breaking transaction atomicity, this is just a set
   * of flags to indicate that the profile doesn't need to be re-fetched.
   */
  async ensureProfiles(
    streamId: StreamDid,
    profileDids: Set<UserDid>,
  ): Promise<Bundle.Statement> {
    try {
      // This only knows how to fetch Bluesky DIDs for now
      const dids = [...profileDids].filter(
        (x) =>
          x.startsWith("did:plc:") ||
          x.startsWith("did:web:") ||
          this.#ensuredProfiles.has(x),
      );
      if (dids.length == 0)
        return {
          status: "profiles",
          dids: [],
          statements: [],
        };

      const missingProfilesResp = (await executeQuery({
        sql: `with existing(did) as (
          values ${dids.map((_) => `(?)`).join(",")}
        )
        select did
        from existing
        left join entities ent on ent.id = existing.did
        where ent.id is null
        `,
        params: dids,
      })) as QueryResult<{ did: string }>; // i think
      const missingDids =
        missingProfilesResp.rows?.map((x: any) => x.did) || [];
      if (missingDids.length == 0)
        return {
          status: "profiles",
          dids: [],
          statements: [],
        };

      const statements = [];

      for (const did of missingDids) {
        this.#ensuredProfiles.add(did);

        const profile = await this.#backend?.getProfile(did);
        if (!profile) continue;

        statements.push(
          ...[
            sql`
            insert into entities (id, stream_id)
            values (${did}, ${streamId})
            on conflict(id) do nothing
          `,
            sql`
            insert into comp_user (did, handle)
            values (
              ${did},
              ${profile.handle}
            )
            on conflict(did) do nothing
          `,
            sql`
            insert into comp_info (entity, name, avatar)
            values (
              ${did},
              ${profile.displayName || profile.handle},
              ${profile.avatar}
            )
            on conflict(entity) do nothing
          `,
          ],
        );
      }

      const bundle = {
        status: "profiles",
        dids: missingDids,
        statements,
      } as const;

      console.log("ensureProfiles bundle", bundle);

      return bundle;
    } catch (e) {
      console.error("Could not ensure profile", e);
      return {
        status: "profileError",
        dids: profileDids,
        message: "Could not ensure profile: " + e,
      };
    }
  }

  private async materializeBatch(
    eventsBatch: Batch.Events,
    priority: TaskPriority = "background",
  ) {
    // so this is where we need to coordinate across the chain of channels
    console.log("Materialising events batch", eventsBatch.batchId);
    const resultPromise = new Promise<Batch.ApplyResult>((resolve) => {
      this.#pendingBatches.set(eventsBatch.batchId, resolve);
    });
    this.#eventChannel.push(eventsBatch, priority);
    return resultPromise;
  }
}

const worker = new SqliteWorkerSupervisor();

globalThis.onmessage = (ev) => {
  worker.initialize(ev.data);
};
