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
import {
  messagePortInterface,
  reactiveWorkerState,
  type ReactiveWorkerState,
} from "../workerMessaging";
import { db } from "../idb";
import schemaSql from "./schema.sql?raw";
import { sql } from "$lib/utils/sqlTemplate";
import {
  AsyncChannel,
  StreamDid,
  Ulid,
  UserDid,
  newUlid,
  type Event,
  type EventType,
} from "@roomy/sdk";
import { materialize } from "./materializer";
import type {
  Savepoint,
  SqliteStatus,
  SqliteWorkerInterface,
  SqlStatement,
} from "./types";
import type { BackendInterface } from "../backend/types";
import { Deferred } from "$lib/utils/deferred";
import { CONFIG } from "$lib/config";
import { requestLock, queryLocks, locksEnabled } from "$lib/workers/locks";
import { initializeFaro, trackUncaughtExceptions } from "$lib/otel";
import { decodeTime, ulid } from "ulidx";
import { context } from "@opentelemetry/api";

initializeFaro({ worker: "sqlite" });

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

const newUserSignals: EventType[] = [
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.joinSpace.v0",
  "space.roomy.message.createMessage.v0",
];

class SqliteWorkerSupervisor {
  // Private state
  #workerId: string;
  #isConnectionHealthy: boolean = true;
  // Heartbeat mechanism to prove this worker is alive
  #heartbeatInterval: NodeJS.Timeout | null = null;
  #status: ReactiveWorkerState<SqliteStatus> = { current: {} };
  #backend: BackendInterface | null = null;
  #ensuredProfiles = new Set<string>();
  #knownStreams = new Set<StreamDid>();
  #eventChannel: AsyncChannel<Batch.Events | Batch.Unstash>;
  #statementChannel = new AsyncChannel<Batch.Statement>();
  #pendingBatches = new Map<string, (result: Batch.ApplyResult) => void>();
  #authenticated = new Deferred();
  /** Spaces to connect after personal stream backfill completes.
   * We accumulate joinSpace events and remove leaveSpace events to ensure
   * we only connect to spaces the user is currently a member of. */
  #pendingSpacesToConnect = new Set<StreamDid>();

  constructor() {
    this.#workerId = crypto.randomUUID();
    this.#eventChannel = new AsyncChannel();
  }

  async initialize(params: {
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

    this.#backend = messagePortInterface<{}, BackendInterface>({
      localName: "sqlite",
      remoteName: "backend",
      messagePort: params.backendPort,
      handlers: {},
    });

    this.#status.workerId = this.#workerId;
    this.#status.isActiveWorker = false; // Initialize to false for reactive state tracking
    this.#status.vfsType = undefined; // Will be set after database initialization
    console.debug("[SqW] (init.1) SQLite Worker Started", {
      workderId: this.#workerId,
      databaseName: params.dbName,
    });

    // initially load only in-memory
    await this.loadDb(params.dbName, false);
    try {
      const sqliteChannel = new MessageChannel();
      messagePortInterface<SqliteWorkerInterface, {}>({
        localName: "sqlite",
        remoteName: "backend",
        messagePort: sqliteChannel.port1,
        handlers: this.getSqliteInterface(),
      });
      this.#backend?.setActiveSqliteWorker(sqliteChannel.port2);
      this.listenEvents();
      this.listenStatements();
      console.debug(
        "[SqW] (init.5) Set active worker, started listeners",
        this.#status.current,
      );
    } catch (error) {
      console.error("SQLite worker initialisation: Fatal error", error);
      this.cleanup();
      throw error;
    }
  }

  private async loadDb(dbName: string, persistent: boolean) {
    const ctx = context.active();

    const callbackStatus = { finishedSuccess: false };
    const callback = async () => {
      await context.with(ctx, async () => {
        console.debug("[SqW] (init.2) Sqlite worker lock obtained", {
          activeWorkerId: this.#workerId,
        });
        this.#status.isActiveWorker = true;
        if (locksEnabled()) {
          this.startHeartbeat();
        }

        globalThis.addEventListener("error", this.cleanup);
        globalThis.addEventListener("unhandledrejection", this.cleanup);

        try {
          await tracer.startActiveSpan("Open DB", {}, ctx, async (span) => {
            await initializeDatabase(dbName, persistent);
            span.end();
          });

          this.#status.vfsType = getVfsType() || undefined;

          // initialise DB schema (should be idempotent)
          console.time("initSql");
          await tracer.startActiveSpan("Init Schema", {}, ctx, async (span) => {
            await this.runSavepoint({ name: "init", items: initSql });
            span.end();
          });
          console.debug("[SqW] (init.4) Schema initialised.");
          console.timeEnd("initSql");

          // Set current schema version
          await executeQuery(sql`
          insert or replace into roomy_schema_version
          (id, version) values (1, ${CONFIG.databaseSchemaVersion})
          `);

          callbackStatus.finishedSuccess = true;
          return;
        } catch (e) {
          console.error("SQLite worker loadDb: Fatal error", e);
          this.cleanup();
          throw e;
        }
      });
    };

    const attemptLock = async (): Promise<void> => {
      // If SharedWorker is disabled, skip locking entirely - each tab has its own worker
      if (!locksEnabled()) {
        await callback();
        return;
      }

      try {
        await requestLock(
          "sqlite-worker-lock",
          { mode: "exclusive", signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
          callback,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          console.warn("SQLite worker: Lock timeout, attempting steal");
          await this.attemptLockSteal(callback);
          // If lock steal didn't succeed, try again
          if (!callbackStatus.finishedSuccess) {
            await attemptLock();
          }
        } else {
          throw error;
        }
      }
    };

    await attemptLock();
  }

  /** Map a batch of incoming events to SQL that applies the event to the entities,
   * components and edges, then forward them to the statements channel for application
   */
  listenEvents() {
    (async () => {
      for await (const batch of this.#eventChannel) {
        const bundles: Bundle.Statement[] = [];

        // console.time("convert-events-to-sql");

        // reset ensured flags for each new batch
        this.#ensuredProfiles = new Set();

        const decodedEvents = batch.events.map((e) => {
          return [e, e.event] as const;
        });

        // Make sure all of the profiles we need are downloaded and inserted
        const neededProfiles = new Set<UserDid>();
        decodedEvents.forEach(([i, ev]) =>
          newUserSignals.includes(ev.$type)
            ? UserDid.allows(i.user)
              ? neededProfiles.add(UserDid.assert(i.user))
              : console.warn("Found invalid user id", i.user)
            : undefined,
        );

        if (neededProfiles.size)
          bundles.push(
            await this.ensureProfiles(batch.streamId, neededProfiles),
          );

        let latestEvent = 0;
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
              // Track space membership changes in personal stream
              // We accumulate these and only connect after full backfill
              // to avoid connecting to spaces the user has since left
              if (event.$type === "space.roomy.space.personal.joinSpace.v0") {
                this.#pendingSpacesToConnect.add(event.spaceDid);
              } else if (
                event.$type === "space.roomy.space.personal.leaveSpace.v0"
              ) {
                this.#pendingSpacesToConnect.delete(event.spaceDid);
              }
            }
          } catch (e) {
            console.warn("Event materialisation failed: " + e);
          }
        }

        this.#statementChannel.push(
          {
            status: "transformed",
            batchId: batch.batchId,
            streamId: batch.streamId,
            bundles: bundles,
            latestEvent: latestEvent as StreamIndex,
            priority: batch.priority,
          },
          batch.priority,
        );
        // console.timeEnd("convert-events-to-sql");
      }
    })();
  }

  /** As batches of materialised events are produced, apply statements to SQLite DB  */
  listenStatements() {
    (async () => {
      for await (const batch of this.#statementChannel) {
        // apply statements
        try {
          const result = await this.runStatementBatch(batch);

          // resolve promise
          try {
            const resolver = this.#pendingBatches.get(batch.batchId);
            if (resolver) {
              resolver(result);
              this.#pendingBatches.delete(batch.batchId);
            } else {
              throw new Error("Lost the resolver 😬");
            }
          } catch (error) {
            console.error("Error running statement batch", batch, error);
          }
        } catch (error) {
          console.error("Error running statement batch", batch, error);
        }
      }
    })();
  }

  private cleanup() {
    console.debug("SQLite worker: Cleaning up...");
    this.stopHeartbeat();
    this.#status.isActiveWorker = false;
    this.#eventChannel.finish();
    this.#statementChannel.finish();

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

  async resetLocalDatabase() {
    console.warn("Resetting local database");
    // await this.untilReady?.catch((error) => {
    //   console.error("Database did not initialise", error);
    // });
    // if (this.#state.state !== "ready")
    //   throw new Error("Sqlite worker not initialized when resetting database.");
    try {
      await this.runQuery(sql`pragma writable_schema = 1`);
      await this.runQuery(sql`delete from sqlite_master`);
      await this.runQuery(sql`vacuum`);
      await this.runQuery(sql`pragma integrity_check`);
      // await personalStream.clearIdCache();
      return { done: true } as const;
    } catch (error) {
      console.error("Database reset failed", error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown error";
      return {
        done: false,
        error: message,
      } as const;
    }
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
    // Lock stealing is only relevant when SharedWorker is enabled
    if (!locksEnabled()) {
      return;
    }

    try {
      // Check if there's a recent heartbeat from another worker
      const heartbeatData = await db.kv.get(HEARTBEAT_KEY);
      if (heartbeatData) {
        const { timestamp, workerId: otherWorkerId } = JSON.parse(
          heartbeatData.value,
        );
        const age = Date.now() - timestamp;

        if (age < LOCK_TIMEOUT_MS && otherWorkerId !== this.#workerId) {
          console.debug(
            "SQLite worker: Another active worker detected, backing off",
          );
          return;
        }
      }

      console.debug(
        "SQLite worker: No recent heartbeat detected, attempting to acquire lock",
      );

      // Try to acquire lock with ifAvailable first
      const lockAcquired = await requestLock(
        "sqlite-worker-lock-backup",
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return false;

          console.debug("SQLite worker: Successfully stole abandoned lock");
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

  async runQuery<Row>(statement: SqlStatement) {
    // This lock makes sure that the JS tasks don't interleave some other query executions in while we
    // are trying to compose a bulk transaction. Only needed with SharedWorker.
    return requestLock(QUERY_LOCK, async () => {
      try {
        return (await executeQuery(statement)) as QueryResult<Row>;
      } catch (e) {
        throw new Error(`Error running SQL query \`${statement.sql}\`: ${e}`);
      }
    });
  }

  private getSqliteInterface(): SqliteWorkerInterface {
    return {
      authenticate: async (did) => {
        // await this.loadDb(did, false); // there is no special reason to have DID-keyed db when it's in memory only. keeping for future transition back to persistent
        this.#status.authenticated = did;
        this.#authenticated.resolve();
        console.debug(
          "[SqW] (init.6) Authenticated. Sqlite worker initialised ✅",
          { did },
        );
      },
      materializeBatch: async (eventsBatch, priority) => {
        return this.materializeBatch(eventsBatch, priority);
      },
      runQuery: this.runQuery,
      resetLocalDatabase: this.resetLocalDatabase,
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
        console.debug("SQLite worker: Ping received");

        // Check lock status (only meaningful when SharedWorker is enabled)
        const lockInfo = await queryLocks();
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
      connectPendingSpaces: async () => {
        const spacesToConnect = [...this.#pendingSpacesToConnect];
        this.#pendingSpacesToConnect.clear();

        console.debug(
          `Connecting ${spacesToConnect.length} pending space(s):`,
          spacesToConnect,
        );

        for (const spaceId of spacesToConnect) {
          await this.connectSpaceStream(spaceId);
        }
      },
    };
  }

  private async runStatementBatch(batch: Batch.Statement) {
    const exec = async () => {
      await executeQuery({ sql: `savepoint batch${batch.batchId}` });

      const results: Batch.ApplyResult["results"] = [];
      const appliedInBatch = new Set<Ulid>();

      const allDependencies = new Set(
        batch.bundles
          .filter(
            (b): b is Bundle.StatementSuccess =>
              b.status === "success" && b.dependsOn !== null,
          )
          .flatMap((b) => b.dependsOn!),
      );

      // Single query for all dependencies
      const satisfiedDeps = new Set<Ulid>();
      if (allDependencies.size > 0) {
        const depsArray = [...allDependencies].flat();

        const result = await executeQuery({
          sql: `SELECT entity_ulid FROM events 
                WHERE entity_ulid IN (${depsArray.map(() => "?").join(",")}) 
                AND applied = 1`,
          params: depsArray,
        });
        result.rows?.forEach((row) =>
          satisfiedDeps.add(row.entity_ulid as Ulid),
        );
      }

      for (const bundle of batch.bundles) {
        if (bundle.status === "success") {
          results.push(
            await this.runStatementBundle(
              bundle,
              batch.streamId,
              appliedInBatch,
              satisfiedDeps,
            ),
          );
        } else if (bundle.status === "profiles") {
          results.push(await this.runStatementProfileBundle(bundle));
        }
      }

      await executeQuery(
        sql`update comp_space set backfilled_to = ${batch.latestEvent} where entity = ${batch.streamId}`,
      );

      console.debug("Updated backfilled_to to", batch.latestEvent);

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
    // are trying to compose a bulk transaction. Only needed with SharedWorker.
    const result: Batch.ApplyResult = await requestLock(QUERY_LOCK, exec);

    await enableLiveQueries();

    return result;
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

  // When triggering unstash, after applying an event:
  private async triggerUnstash(
    appliedEventId: Ulid,
    streamId: StreamDid,
    user: UserDid,
    priority: TaskPriority,
  ) {
    const stashed = await executeQuery(sql`
      SELECT idx, entity_ulid, payload
      FROM events
      WHERE depends_on = ${appliedEventId} AND applied = 0
      ORDER BY idx ASC
    `);

    if (!stashed.rows?.length) return;

    // Create unstash batch and push to channel
    const unstashBatch: Batch.Unstash = {
      status: "unstash",
      batchId: newUlid(),
      streamId,
      priority,
      events: stashed.rows.map((row) => ({
        idx: row.idx as StreamIndex,
        event: JSON.parse(row.payload as string) as Event,
        user /* need to store this too, or derive from event */,
      })),
    };

    this.#eventChannel.push(unstashBatch, priority);
  }

  /** Process a Statement Bundle. The actual statements are handled in runBundleStatements */
  private async runStatementBundle(
    bundle: Bundle.StatementSuccess,
    streamId: StreamDid,
    appliedInBatch: Set<Ulid>,
    satisfiedDeps: Set<Ulid>,
  ): Promise<Bundle.ApplyResult | Bundle.ApplyStashed> {
    const bundleId = bundle.event.id;

    const isSatisfied =
      bundle.dependsOn.length == 0 ||
      bundle.dependsOn.every((x) => satisfiedDeps.has(x)) ||
      bundle.dependsOn.every((x) => appliedInBatch.has(x));

    if (bundle.dependsOn && !isSatisfied) {
      // STASH: Insert event with applied=0
      await executeQuery(sql`
            INSERT INTO events (idx, stream_id, user, entity_ulid,  payload, applied, depends_on)
            VALUES (${bundle.eventIdx}, ${streamId}, ${bundle.user}, ${bundle.event.id},
                    ${JSON.stringify(bundle.event)}, 0, ${JSON.stringify(bundle.dependsOn)})
            ON CONFLICT(idx, stream_id) DO NOTHING
          `);

      return {
        result: "stashed",
        eventId: bundle.event.id,
        dependsOn: bundle.dependsOn,
      };
    }

    const queryResults = await this.runBundleStatements(
      bundleId,
      bundle.statements,
      {
        event: bundle.event,
        streamId,
        idx: bundle.eventIdx,
        user: bundle.user,
      },
    );

    // Track that we applied this
    appliedInBatch.add(bundle.event.id);

    // Check for stashed events that can now be applied
    this.triggerUnstash(bundle.event.id, streamId, bundle.user, "priority");

    return {
      result: "applied",
      eventId: bundle.event.id,
      output: queryResults,
    };
  }

  /** Given a bundle of SQL statements (corresponding to a materialised event needing application),
   * apply those SQL statements to the DB, and insert the event.
   */
  private async runBundleStatements(
    bundleId: string,
    statements: SqlStatement[],
    eventMeta?: {
      event: Event;
      streamId: StreamDid;
      idx: StreamIndex;
      user: UserDid;
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

    // insert event to events table
    if (eventMeta) {
      const insertEvent = sql`
        INSERT INTO events (idx, stream_id, user, entity_ulid, payload, applied)
        VALUES (${eventMeta.idx}, ${eventMeta.streamId}, ${eventMeta.user}, ${eventMeta.event.id}, ${JSON.stringify(eventMeta.event)}, ${hadError ? 0 : 1})
        ON CONFLICT DO NOTHING
        `;
      queryResults.push(
        await executeQuery(insertEvent).catch((e) => {
          return {
            type: "error",
            statement: insertEvent,
            message: e instanceof Error ? e.message : (e as string),
          };
        }),
      );

      // If this event is a reorder event that modifies the `after` position for another event.
      if (
        eventMeta.event.$type == "space.roomy.message.reorderMessage.v0" &&
        eventMeta.event.after
      ) {
        // We need to update the event's "after" field
        // await executeQuery(
        //   sql`update entities set after = ${eventMeta.event.variant.after} where id = ${eventMeta.event.variant.entity}`,
        // );

        // And we need to re-materialize it's sort position
        await this.materializeEntitySortPosition({
          streamId: eventMeta.streamId,
          ulid: eventMeta.event.messageId,
          after: eventMeta.event.after,
          update: true,
        });
      }
    }

    await executeQuery({ sql: `release bundle${bundleId}` });
    return queryResults;
  }

  /** Adds a sort index to an entity. The sort index is based on the ULID, but mutable via app-level
   * re-ordering events, which calculates the lexicographic midpoint between the previous event and whichever ULID comes next.
   */
  // TODO: I think this is nearly working, and seems to be fine for messages, but there also seems
  // to be problems when moving the same items over and over again in the sidebar. It might have to
  // do with partial loading but I'm not sure.
  private async materializeEntitySortPosition({
    streamId,
    ulid,
    after,
    update,
  }: {
    streamId: StreamDid;
    ulid: Ulid;
    after: Ulid;
    update?: boolean;
  }): Promise<void> {
    // Check this entity's sort index
    const existingEntity = (
      await executeQuery<{
        sort_idx: string | null;
      }>(sql`select sort_idx from entities where id = ${ulid}`)
    ).rows?.[0];

    // Skip completely if the materialization didn't create an entity for this event
    if (!existingEntity) return;

    // Skip completely if this entity already has a sort index
    if (!update && existingEntity.sort_idx) {
      return;
    }

    // First we need to get the closest entity that comes before this one.
    // Try to get the event this one is after if it exists
    const eventBeforeThisOne = (
      await executeQuery<{
        sort_idx?: string;
      }>(sql`
          select coalesce(sort_idx, id) as sort_idx -- fall back to ULID
          from entities
          where stream_id = ${streamId} and id = ${after}
          limit 1
        `)
    ).rows?.[0];

    if (!eventBeforeThisOne)
      throw new Error("Entity given by 'after' does not exist");

    // Now we need to get the closest entity that comes after this one
    // We want to sort it _immediately_ after, so we need to find the entity that _currently_
    // sorts immediately after it and stick it in between.
    const eventAfterThisOne = (
      await executeQuery<{ sort_idx: string }>(sql`
          select sort_idx
          from entities
          where
            stream_id = ${streamId}
              and
            sort_idx > ${eventBeforeThisOne.sort_idx}
              and
            id != ${ulid}
          order by sort_idx
          limit 1
        `)
    ).rows?.[0];

    // Finally we can compute the sort index for this entity
    try {
      const sortIdx = midpointUlid(
        Ulid.assert(eventBeforeThisOne?.sort_idx),
        (eventAfterThisOne?.sort_idx as Ulid) || undefined,
      );

      // Now we can update the sort index for this entity
      await executeQuery(
        sql`update entities set sort_idx = ${sortIdx} where id = ${ulid}`,
      );
    } catch (e) {
      console.error(
        "Could not reorder message. Error getting midpoint ULID:",
        e,
      );
      return;
    }
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
      disableLiveQueries();

      // This lock makes sure that the JS tasks don't interleave some other query executions in while we
      // are trying to compose a bulk transaction. Only needed with SharedWorker.
      const result = await requestLock(QUERY_LOCK, exec);

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

      console.debug("ensureProfiles bundle", bundle);

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
    const resultPromise = new Promise<Batch.ApplyResult>((resolve) => {
      this.#pendingBatches.set(eventsBatch.batchId, resolve);
    });
    this.#eventChannel.push(eventsBatch, priority);
    return resultPromise;
  }
}

const worker = new SqliteWorkerSupervisor();

// Debugging hooks
(globalThis as any).worker = worker;
(globalThis as any).debugSqlite = {
  disableLiveQueries,
  enableLiveQueries,
  executeQuery,
};

globalThis.onmessage = (ev) => {
  faro.api.setSession({
    id: ev.data?.sessionId,
    attributes: { isSampled: "true" },
  });
  tracer.startActiveSpan("Init SQLite Worker", async (span) => {
    await trackUncaughtExceptions(async () => {
      await worker.initialize(ev.data);
    });
    span.end();
  });
};

function midpointUlid(earlier: Ulid, later?: Ulid) {
  const earlierTime = decodeTime(earlier);

  // if there's no after event, put it 10ms after the first one
  const laterTime = later ? decodeTime(later) : decodeTime(earlier + 10);

  const midTimeDiff = (laterTime - earlierTime) / 2;
  return ulid(earlierTime + midTimeDiff);
}
