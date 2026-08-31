/**
 * E2E test fixture — reusable helper for HTTP-level appserver tests.
 *
 * Provides:
 * - `startAppserver(opts?)` — spins a clean appserver on an ephemeral port
 *   with test auth, :memory: DBs, and disabled backfill.
 * - `seedSpace(db, spaceId, userDid)` — inserts a space + membership into
 *   the materialisation DB so read endpoints have data.
 * - `seedRoom(db, roomId, spaceId, label?)` — inserts a room entity.
 * - `seedMessage(db, msgId, roomId, spaceId, sortIdx?)` — inserts a message.
 * - `seedUser(db, userDid, handle?)` — inserts a user entity + comp_user row.
 * - `seedMembership(db, spaceId, userDid, label?)` — inserts a membership edge.
 * - `seedRole(db, roleId, spaceId, name?)` — inserts a role.
 * - `seedInvite(db, spaceId, token, creatorDid)` — inserts an invite token.
 * - `seedReaction(db, msgId, userDid, reaction)` — inserts a reaction.
 * - `seedActivityItem(db, roomId, spaceId, lastActivityAt)` — inserts an
 *   activity feed item.

 */

import { afterEach } from "bun:test";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetRateLimit } from "../xrpc/rateLimit.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../embed/sweeper.ts";
import { stopSearchIndexer, _resetSearchIndexer } from "../search/indexer.ts";
import { stopSearchBackfill, _resetSearchBackfill } from "../search/backfill.ts";
import { _resetQdrantClient, _resetMessagesCollection } from "../search/qdrantSearch.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../queries/profileStore.ts";
import { newUlid } from "@roomy-space/sdk";
import type { Database } from "bun:sqlite";

// ─── Appserver lifecycle ─────────────────────────────────────────────────

export interface E2eContext {
  handle: AppserverHandle;
  baseUrl: string;
  /** Returns a fetch wrapper that injects X-Test-Did: <did>. */
  authedFetch: (did: string) => (url: string, init?: RequestInit) => Promise<Response>;
  /** Plain fetch (no auth header). */
  anonFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The singleton DB handle (for direct queries in assertions). */
  db: Database;
}

/**
 * Start a clean appserver for e2e testing.
 *
 * - testAuthVerifier (X-Test-Did header)
 * - :memory: DBs
 * - backfillMode: "disabled"
 * - quiet: true
 * - ephemeral port
 *
 * Registers a Bun test teardown to close the server and reset singletons.
 * Call this inside `beforeEach` or at the top of a `describe` block.
 */
export async function startAppserver(): Promise<E2eContext> {
  // Stop any running background sweeper/indexer loops before resetting state.
  await stopEmbedSweeper();
  await stopSearchIndexer();
  await stopSearchBackfill();
  closeDb();
  _resetRateLimit();
  _resetHydrationInflight();
  _resetEmbedSweeper();
  _resetSearchIndexer();
  _resetSearchBackfill();
  _resetQdrantClient();
  _resetMessagesCollection();
  _resetProfileStoreCache();
  // Hermetic: without stubs, profile hydration falls back to live
  // api.bsky.app fetches, which pile up under parallel load and blow the
  // 5s per-test timeout. Tests don't assert on profile materialization, so
  // no-op fetchers are safe.
  _setTestGetProfiles(async () => []);

  // Open the singleton DB in-memory so handlers' internal openDb() resolves.
  const db = openDb({ path: ":memory:" }) as unknown as Database;

  const handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    // No detached background loops (embed sweeper, search indexer/backfill,
    // push dispatcher) in tests: request handling is what these tests
    // exercise, and a loop that wakes against a closed DB after teardown is
    // the #1 CI flake source (unhandled "Database is closed" rejections).
    // Tests that exercise the loops start them explicitly (e.g.
    // search.test.ts starts the backfill sweeper itself).
    disableBackgroundWorkers: true,
    // Keep E2E runs hermetic: without a stub, materialization falls back to
    // live api.bsky.app profile fetches, which pile up under parallel load
    // and blow the 5s per-test timeout. Tests don't assert on profile
    // materialization, so a no-op fetcher is safe.
    getProfiles: async () => [],
  });

  const baseUrl = `http://localhost:${handle.port}`;

  const authedFetch = (did: string) => {
    return (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          "X-Test-Did": did,
          "Content-Type": "application/json",
        },
      });
  };

  const anonFetch = (url: string, init?: RequestInit) =>
    fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        "Content-Type": "application/json",
      },
    });

  // Register teardown so Bun cleans up after the test.
  afterEach(async () => {
    await handle.close();
    _resetHydrationInflight();
    _resetEmbedSweeper();
    _resetSearchIndexer();
    _resetSearchBackfill();
    _resetQdrantClient();
    _resetMessagesCollection();
    _resetProfileStoreCache();
    _setTestGetProfiles(null);
  });

  return { handle, baseUrl, authedFetch, anonFetch, db };
}


// ─── DB seed helpers ──────────────────────────────────────────────────────

/**
 * Seed a space with the given ID and a membership for the given user.
 * Also seeds the user entity and comp_user row if they don't exist.
 *
 * Returns the space entity ID for chaining.
 */
export function seedSpace(
  db: Database,
  spaceId: string,
  userDid: string,
  opts?: { handle?: string; allowPublicJoin?: number },
): string {
  const sp = spaceDb(db, spaceId);
  // Space entity
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [spaceId, spaceId],
  );
  // comp_space row
  sp.run(
    `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
     values (?, ?, ?, ?)`,
    [spaceId, opts?.handle ?? null, opts?.allowPublicJoin ?? null, 1],
  );
  // comp_info row (for name/avatar/description)
  sp.run(
    `insert or ignore into comp_info (entity, name)
     values (?, ?)`,
    [spaceId, "Test Space"],
  );
  // The user's entity + comp_user row live in the user's OWN per-space DB,
  // but for e2e seeding convenience we also write them to this space's
  // per-space DB so member-edge FK constraints hold.
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [userDid, userDid],
  );
  sp.run(
    "insert or ignore into comp_user (did, handle) values (?, ?)",
    [userDid, null],
  );
  // Membership edge: user is a member of the space.
  // The isMember/isAdmin checks in auth/access.ts use head=spaceId, tail=did.
  sp.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'member')`,
    [spaceId, userDid],
  );
  // Also seed the reverse direction for queries that use head=did, tail=spaceId.
  sp.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'member')`,
    [userDid, spaceId],
  );
  // Global entity→space index entry (Phase 3) so openSpaceDbForEntity and
  // related lookups resolve the space id.
  globalDb(db).run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [spaceId, spaceId],
  );
  return spaceId;
}

/**
 * Seed a joinedSpace edge from the user to the space (global DB, kept for
 * backward-compat assertions) AND durable membership intent in the read-state
 * DB (what getSpaces now reads).
 */
export function seedJoinedSpace(
  db: Database,
  userDid: string,
  spaceId: string,
): void {
  globalDb(db).run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'joinedSpace')`,
    [userDid, spaceId],
  );
  readStateDb(db).run(
    `insert into user_space_membership
       (user_did, space_did, state, source, source_event_id)
     values (?, ?, 'joined', 'seed', ?)
     on conflict(user_did, space_did) do update set
       state = excluded.state,
       source = excluded.source,
       source_event_id = excluded.source_event_id`,
    [userDid, spaceId, `01SEED${spaceId}`],
  );
}

/**
 * Seed a room entity + comp_room row in the room's per-space DB, plus the
 * global `entity_space` index entry (Phase 3) so `openSpaceDbForEntity`
 * can resolve the room to its owning space.
 */
export function seedRoom(
  db: Database,
  roomId: string,
  spaceId: string,
  label?: string,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [roomId, spaceId],
  );
  sp.run(
    `insert or ignore into comp_room (entity, label)
     values (?, ?)`,
    [roomId, label ?? "space.roomy.channel"],
  );
  globalDb(db).run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [roomId, spaceId],
  );
}

/**
 * Seed a message entity + comp_content row in the room's per-space DB, plus
 * the global `entity_space` index entry so `openSpaceDbForEntity` can
 * resolve the message to its owning space.
 */
export function seedMessage(
  db: Database,
  msgId: string,
  roomId: string,
  spaceId: string,
  sortIdx?: string,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    "insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgId, spaceId, roomId, sortIdx ?? msgId],
  );
  sp.run(
    `insert or ignore into comp_content (entity, mime_type, data, last_edit)
     values (?, 'text/html', ?, ?)`,
    [msgId, new TextEncoder().encode("<p>hello</p>"), msgId],
  );
  globalDb(db).run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [msgId, spaceId],
  );
}

/**
 * Seed a user profile in the global `profiles` table (Phase 3). Roomy
 * profiles are global (one per user), so `seedUser` writes there rather than
 * to any per-space DB.
 */
export function seedUser(
  db: Database,
  userDid: string,
  handle?: string,
): void {
  globalDb(db).run(
    "insert or ignore into profiles (did, handle) values (?, ?)",
    [userDid, handle ?? null],
  );
}

/**
 * Seed a membership edge (member or admin) in the space's per-space DB.
 */
export function seedMembership(
  db: Database,
  spaceId: string,
  userDid: string,
  label?: "member" | "admin",
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, ?)`,
    [userDid, spaceId, label ?? "member"],
  );
}

/**
 * Seed a role in the space's per-space DB.
 */
export function seedRole(
  db: Database,
  roleId: string,
  spaceId: string,
  name?: string,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    `insert into roles (id, stream_id, name)
     values (?, ?, ?)`,
    [roleId, spaceId, name ?? "Test Role"],
  );
}

/**
 * Assign a user to a role in the space's per-space DB.
 */
export function seedMemberRole(
  db: Database,
  userId: string,
  roleId: string,
  spaceId: string,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    `insert into member_roles (user_id, role_id, stream_id)
     values (?, ?, ?)`,
    [userId, roleId, spaceId],
  );
}

/**
 * Seed an invite token in the space's per-space DB.
 */
export function seedInvite(
  db: Database,
  spaceId: string,
  token: string,
  creatorDid: string,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    `insert into comp_invite (entity, token, created_by_did, event_ulid)
     values (?, ?, ?, ?)`,
    [spaceId, token, creatorDid, newUlid()],
  );
}

/**
 * Seed a reaction on a message in the owning space's per-space DB. The
 * owning space is resolved from the global `entity_space` index (seeded by
 * `seedMessage`).
 */
export async function seedReaction(
  db: Database,
  msgId: string,
  userDid: string,
  reaction: string,
): Promise<void> {
  const row = await globalDb(db)
    .query("select space_did from entity_space where entity_id = ?")
    .get<{ space_did: string }>(msgId);
  const spaceId = row?.space_did;
  if (!spaceId) return;
  const sp = spaceDb(db, spaceId);
  await sp.run(
    `insert into comp_reaction (entity, user, reaction_id, reaction)
     values (?, ?, ?, ?)`,
    [msgId, userDid, newUlid(), reaction],
  );
}

/**
 * Seed an activity feed item in the space's per-space DB.
 */
export function seedActivityItem(
  db: Database,
  roomId: string,
  spaceId: string,
  lastActivityAt?: number,
): void {
  const sp = spaceDb(db, spaceId);
  sp.run(
    `insert into activity_item (room_id, space_id, last_activity_at, recent_message_ids)
     values (?, ?, ?, ?)`,
    [roomId, spaceId, lastActivityAt ?? Date.now(), "[]"],
  );
}

/**
 * Seed a read position in the read-state DB (Phase 3: read-state is its own
 * routed DB, `data/roomy-readstate.sqlite`).
 */
export function seedReadPosition(
  db: Database,
  userDid: string,
  roomId: string,
  seenUpTo: string,
  unreadCount?: number,
): void {
  readStateDb(db).run(
    `insert or ignore into read_positions (user_did, room_id, seen_up_to, unread_count)
     values (?, ?, ?, ?)`,
    [userDid, roomId, seenUpTo, unreadCount ?? 0],
  );
}

// ─── Phase 3 DB routing ──────────────────────────────────────────────────

/**
 * The e2e seed helpers are handed the base AsyncDatabase handle returned by
 * `openDb()` (the event-log DB). In Phase 3 the materialised data lives in
 * the per-space DBs (`forSpace`) and the global DB (`global`), so the seed
 * helpers route each write to the correct database. These small helpers keep
 * that routing typed and local to this file.
 */
type RoutedDb = {
  forSpace(spaceDid: string): AsyncLike;
  global(): AsyncLike;
  readState(): AsyncLike;
};
type AsyncLike = {
  query(sql: string): {
    get<T>(...params: unknown[]): Promise<T | null>;
  };
  run(sql: string, ...params: unknown[]): Promise<unknown>;
};

/**
 * Seed writes are fire-and-forget: the test body runs synchronously and the
 * `afterEach` teardown (`closeDb()`) can terminate the worker while seed
 * requests are still in flight, rejecting their promises. A dropped promise
 * surfaces as an unhandled rejection and fails the whole run (bun exits 1).
 * Attach a no-op catch so the rejection is considered handled — awaited
 * callers still observe it via the returned promise.
 */
function swallowDropped<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

function wrapAsyncLike(inner: AsyncLike): AsyncLike {
  return {
    query: (sql) => inner.query(sql),
    run: (sql, ...params) => swallowDropped(inner.run(sql, ...params)),
  };
}

/** Route a write to a space's per-space DB (entities, comp_room, edges). */
export function spaceDb(db: Database, spaceDid: string): AsyncLike {
  return wrapAsyncLike((db as unknown as RoutedDb).forSpace(spaceDid));
}

function globalDb(db: Database): AsyncLike {
  return wrapAsyncLike((db as unknown as RoutedDb).global());
}

/** Route a write to the read-state DB (read_positions, user_thread_activity). */
export function readStateDb(db: Database): AsyncLike {
  return wrapAsyncLike((db as unknown as RoutedDb).readState());
}

// ─── Full-path materialization helper ────────────────────────────────────

export interface MaterializedSpace {
  roomId: string;
  messageId: string;
}

/**
 * Set up a fully-materialized space through the REAL write path, so tests
 * exercise the materializer (applyBatch → per-space DB + global entity_space
 * index) rather than seeding rows directly. This is what catches regressions
 * like room-scoped handlers 404ing because the entity→space index was never
 * populated.
 *
 * Seeds the space + membership + admin edge directly (createSpace needs a
 * reachable PLC directory, which CI doesn't have), then sends a createRoom
 * and a createMessage via `space.roomy.space.sendEvents`. Returns the
 * materialized room + message ids.
 */
export async function materializeSpace(
  ctx: E2eContext,
  spaceId: string,
  userDid: string,
  opts?: { roomName?: string; messageText?: string },
): Promise<MaterializedSpace> {
  seedSpace(ctx.db as unknown as Database, spaceId, userDid, { allowPublicJoin: 1 });
  seedJoinedSpace(ctx.db as unknown as Database, userDid, spaceId);
  await (ctx.db as unknown as RoutedDb).forSpace(spaceId).run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [spaceId, userDid],
  );

  const roomId = newUlid();
  const r1 = await ctx.authedFetch(userDid)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        events: [
          {
            id: roomId,
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name: opts?.roomName ?? "general",
          },
        ],
      }),
    },
  );
  if (r1.status !== 200) {
    throw new Error(`materializeSpace: createRoom failed ${r1.status}: ${await r1.text()}`);
  }

  const messageId = newUlid();
  const r2 = await ctx.authedFetch(userDid)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        events: [
          {
            id: messageId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(opts?.messageText ?? "hello").toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (r2.status !== 200) {
    throw new Error(`materializeSpace: createMessage failed ${r2.status}: ${await r2.text()}`);
  }

  return { roomId, messageId };
}
