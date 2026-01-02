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
import {
  StreamDid,
  Ulid,
  UserDid,
  newUlid,
  parseEvent,
  type Event,
  type EventType,
} from "$lib/schema";
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
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";

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

console.info("Started sqlite worker");

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
  "space.roomy.stream.addAdmin.v0",
  "space.roomy.room.joinRoom.v0",
  "space.roomy.message.sendMessage.v0",
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
  #eventChannel: AsyncChannel<Batch.Events | Batch.Unstash>;
  #statementChannel = new AsyncChannel<Batch.Statement>();
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
        this.listenEvents();
        this.listenStatements();
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

  /** Map a batch of incoming events to SQL that applies the event to the entities,
   * components and edges, then forward them to the statements channel for application
   */
  listenEvents() {
    (async () => {
      for await (const batch of this.#eventChannel) {
        const bundles: Bundle.Statement[] = [];

        console.time("convert-events-to-sql");

        // reset ensured flags for each new batch
        this.#ensuredProfiles = new Set();

        const decodedEvents =
          batch.status === "events"
            ? batch.events
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
                .filter((e): e is Exclude<typeof e, null> => e !== null)
            : batch.events.map((e) => {
                return [e, e.event] as const;
              });

        // Make sure all of the profiles we need are downloaded and inserted
        const neededProfiles = new Set<UserDid>();
        decodedEvents.forEach(([i, ev]) =>
          newUserSignals.includes(ev.variant.$type)
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
              if (
                event.variant.$type ===
                "space.roomy.stream.personal.joinSpace.v0"
              ) {
                spacesToConnect.push(event.variant.spaceDid);
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

  /** As batches of materialised events are produced, apply statements to SQLite DB  */
  listenStatements() {
    (async () => {
      for await (const batch of this.#statementChannel) {
        // apply statements
        try {
          const result = await this.runStatementBatch(batch);
          console.log(
            "Ran statements",
            batch,
            "got result",
            result,
            "pushing to resultChannel",
          );

          // resolve promises
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

  private cleanup() {
    console.log("SQLite worker: Cleaning up...");
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
        // await this.loadDb(did, false); // there is no special reason to have DID-keyed db when it's in memory only. keeping for future transition back to persistent
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
        const depsArray = [...allDependencies];
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

      // If this event is a move event that modifies the `after` position for another event.
      if (
        eventMeta.event.variant.$type == "space.roomy.room.move.v0" &&
        eventMeta.event.variant.after
      ) {
        // We need to update the event's "after" field
        await executeQuery(
          sql`update entities set after = ${eventMeta.event.variant.after} where id = ${eventMeta.event.variant.entity}`,
        );

        // And we need to re-materialize it's sort position
        await this.materializeEntitySortPosition({
          streamId: eventMeta.streamId,
          ulid: eventMeta.event.variant.entity,
          after: eventMeta.event.variant.after,
          update: true,
        });
      } else {
        // If this is not a move event
        // Materialize the entity's sort position
        await this.materializeEntitySortPosition({
          streamId: eventMeta.streamId,
          ulid: eventMeta.event.id,
          after: eventMeta.event.after,
        });
      }
    }

    await executeQuery({ sql: `release bundle${bundleId}` });
    return queryResults;
  }

  /** Materialize the entity's sort index */
  // TODO: I think this is nearly working, and seems to be fine for messages, but there also seems
  // to be problems when moving the same items over and over again in the sidebar. It might have to
  // do with partial loading but I'm not sure.
  private async materializeEntitySortPosition({
    streamId,
    ulid,
    after,
    update,
  }: {
    streamId: string;
    ulid: string;
    after?: string;
    update?: boolean;
  }): Promise<void> {
    // Determine this entity's sort index

    const existingEntity = (
      await executeQuery<{
        id: string;
        sort_idx: string | null;
      }>(sql`select id, sort_idx from entities where id = ${ulid}`)
    ).rows?.[0];

    // Skip completely if the materialization didn't bother to create an entity for this event
    if (!existingEntity) return;

    // Skip completely if this entity already has a sort index
    if (!update && existingEntity.sort_idx) {
      return;
    }

    // First we need to get the closest entity that comes before this one.
    let eventBeforeThisOne: { id: string; sort_idx?: string } | undefined;

    // If this entity is `after` a specific entity, then we are looking for that entity, or else the one
    // with the closest preceding ulid, if we haven't materialized the `after` entity yet.
    if (after) {
      // Try to get the event this one is after if it exists
      eventBeforeThisOne = (
        await executeQuery<{
          id: string;
          sort_idx?: string;
        }>(sql`
          select id, sort_idx
          from entities
          where stream_id = ${streamId} and id = ${after}
          limit 1
        `)
      ).rows?.[0];

      // If that didn't work, just get get the previous event by its ulid
      if (!eventBeforeThisOne) {
        eventBeforeThisOne = (
          await executeQuery<{
            id: string;
            sort_idx?: string;
          }>(sql`
            select id, sort_idx
            from entities
            where 
              stream_id = ${streamId}
                and
              id < ${ulid}
            order by id desc
            limit 1
        `)
        ).rows?.[0];
      }
    } else {
      // If this event isn't `after` a specific entity, then we are just looking for the closest
      // preceding entity ulid.
      eventBeforeThisOne = (
        await executeQuery<{
          id: string;
          sort_idx?: string;
        }>(sql`
            select id, sort_idx
            from entities
            where 
              stream_id = ${streamId}
                and
              id < ${ulid}
            order by id desc
            limit 1
        `)
      ).rows?.[0];
    }

    // Now we need to get the closest entity that comes after this one
    let eventAfterThisOne: { id: string; sort_idx?: string } | undefined;

    // If this entity is supposed to come after a specific entity, then we want to sort it
    // _immediately_ after, so we need to find the entity that _currently_ sorts immediately after
    // it and stick it in between.
    if (after && eventBeforeThisOne) {
      eventAfterThisOne = (
        await executeQuery<{ id: string; sort_idx: string }>(sql`
          select id, sort_idx
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
    } else {
      // If this entity isn't supposed to come after any specific entity, then we just stick it before
      // the nearest entity with a higher ulid.
      eventAfterThisOne = (
        await executeQuery<{ id: string; sort_idx: string }>(sql`
          select id, sort_idx
          from entities
          where
            stream_id = ${streamId}
              and
            id > ${ulid} 
          order by id
          limit 1
        `)
      ).rows?.[0];
    }

    // Finally we can compute the sort index for this entity

    let sortIdx: string | undefined;
    try {
      sortIdx = generateJitteredKeyBetween(
        eventBeforeThisOne?.sort_idx || null,
        eventAfterThisOne?.sort_idx || null,
      );
    } catch (e) {
      return;
    }

    // Now we can update the sort index for this entity
    await executeQuery(
      sql`update entities set sort_idx = ${sortIdx} where id = ${ulid}`,
    );

    // Now we get the list of other entities that should be sorted after *this* entity. These are
    // entities that were supposed to be sorted be after this one, but couldn't be sorted properly
    // because this entity hadn't been materialized yet.
    const eventsAfterThisEvent =
      (
        await executeQuery<{ id: string }>(
          sql`select id from entities where after = ${ulid}`,
        )
      ).rows?.map((x) => x.id) || [];

    // Calculate the sort index for all of the events after this one. It's OK that they all have the
    // same sort idx, the ULID is the tie breaker.
    const sortIdxAfterThisEvent = generateJitteredKeyBetween(
      sortIdx,
      eventAfterThisOne?.sort_idx || null,
    );

    // Update the sort index for all of those events.
    await executeQuery({
      sql: `update entities set sort_idx = ? where id in (${eventsAfterThisEvent.map((_) => "?").join(",")})`,
      params: [sortIdxAfterThisEvent, ...eventsAfterThisEvent],
    });
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
            INSERT INTO events (idx, stream_id, user, entity_ulid, after_entity, payload, applied, depends_on)
            VALUES (${bundle.eventIdx}, ${streamId}, ${bundle.user}, ${bundle.event.id}, ${bundle.event.after || null}
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
