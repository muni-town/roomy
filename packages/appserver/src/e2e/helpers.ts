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
 * - `seedPersonalStream(db, userDid, personalStreamDid)` — inserts the
 *   personal-stream cache row.
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
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../embed/sweeper.ts";
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
  // Stop any running background sweeper loop before resetting state.
  await stopEmbedSweeper();
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  // Open the singleton DB in-memory so handlers' internal openDb() resolves.
  const db = openDb({ path: ":memory:" }) as unknown as Database;

  const handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
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
  // Space entity
  db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [spaceId, spaceId],
  );
  // comp_space row
  db.run(
    `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
     values (?, ?, ?, ?)`,
    [spaceId, opts?.handle ?? null, opts?.allowPublicJoin ?? null, 1],
  );
  // comp_info row (for name/avatar/description)
  db.run(
    `insert or ignore into comp_info (entity, name)
     values (?, ?)`,
    [spaceId, "Test Space"],
  );
  // User entity
  db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [userDid, userDid],
  );
  // comp_user row
  db.run(
    "insert or ignore into comp_user (did, handle) values (?, ?)",
    [userDid, null],
  );
  // Membership edge: user is a member of the space.
  // The isMember/isAdmin checks in auth/access.ts use head=spaceId, tail=did.
  db.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'member')`,
    [spaceId, userDid],
  );
  // Also seed the reverse direction for queries that use head=did, tail=spaceId.
  db.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'member')`,
    [userDid, spaceId],
  );
  return spaceId;
}



/**
 * Seed a personal-stream cache row so hydrateUserMembership can resolve
 * the user's personal stream without Leaf.
 */
export function seedPersonalStream(
  db: Database,
  userDid: string,
  personalStreamDid: string,
): void {
  db.run(
    `insert or ignore into comp_user_personal_stream (user_did, personal_stream_did, resolved_at)
     values (?, ?, ?)`,
    [userDid, personalStreamDid, 0],
  );
}

/**
 * Seed a joinedSpace edge from the personal stream to the space.
 * This is what getSpaces reads to determine membership.
 * Also inserts the personal stream entity if it doesn't exist (edges
 * have FK constraints on entities(id)).
 */
export function seedJoinedSpace(
  db: Database,
  personalStreamDid: string,
  spaceId: string,
): void {
  // Ensure the personal stream has an entity row (edges FK on entities(id)).
  db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [personalStreamDid, personalStreamDid],
  );
  db.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, 'joinedSpace')`,
    [personalStreamDid, spaceId],
  );
}

/**
 * Seed a room entity + comp_room row.
 */
export function seedRoom(
  db: Database,
  roomId: string,
  spaceId: string,
  label?: string,
): void {
  db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [roomId, spaceId],
  );
  db.run(
    `insert or ignore into comp_room (entity, label)
     values (?, ?)`,
    [roomId, label ?? "space.roomy.channel"],
  );
}

/**
 * Seed a message entity + comp_content row.
 */
export function seedMessage(
  db: Database,
  msgId: string,
  roomId: string,
  spaceId: string,
  sortIdx?: string,
): void {
  db.run(
    "insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgId, spaceId, roomId, sortIdx ?? msgId],
  );
  db.run(
    `insert or ignore into comp_content (entity, mime_type, data, last_edit)
     values (?, 'text/html', ?, ?)`,
    [msgId, new TextEncoder().encode("<p>hello</p>"), msgId],
  );
}

/**
 * Seed a user entity + comp_user row.
 */
export function seedUser(
  db: Database,
  userDid: string,
  handle?: string,
): void {
  db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [userDid, userDid],
  );
  db.run(
    "insert or ignore into comp_user (did, handle) values (?, ?)",
    [userDid, handle ?? null],
  );
}

/**
 * Seed a membership edge (member or admin).
 */
export function seedMembership(
  db: Database,
  spaceId: string,
  userDid: string,
  label?: "member" | "admin",
): void {
  db.run(
    `insert or ignore into edges (head, tail, label)
     values (?, ?, ?)`,
    [userDid, spaceId, label ?? "member"],
  );
}

/**
 * Seed a role.
 */
export function seedRole(
  db: Database,
  roleId: string,
  spaceId: string,
  name?: string,
): void {
  db.run(
    `insert into roles (id, stream_id, name)
     values (?, ?, ?)`,
    [roleId, spaceId, name ?? "Test Role"],
  );
}

/**
 * Assign a user to a role.
 */
export function seedMemberRole(
  db: Database,
  userId: string,
  roleId: string,
  spaceId: string,
): void {
  db.run(
    `insert into member_roles (user_id, role_id, stream_id)
     values (?, ?, ?)`,
    [userId, roleId, spaceId],
  );
}

/**
 * Seed an invite token.
 */
export function seedInvite(
  db: Database,
  spaceId: string,
  token: string,
  creatorDid: string,
): void {
  db.run(
    `insert into comp_invite (entity, token, created_by_did, event_ulid)
     values (?, ?, ?, ?)`,
    [spaceId, token, creatorDid, newUlid()],
  );
}

/**
 * Seed a reaction on a message.
 */
export function seedReaction(
  db: Database,
  msgId: string,
  userDid: string,
  reaction: string,
): void {
  db.run(
    `insert into comp_reaction (entity, user, reaction_id, reaction)
     values (?, ?, ?, ?)`,
    [msgId, userDid, newUlid(), reaction],
  );
}

/**
 * Seed an activity feed item.
 */
export function seedActivityItem(
  db: Database,
  roomId: string,
  spaceId: string,
  lastActivityAt?: number,
): void {
  db.run(
    `insert into activity_item (room_id, space_id, last_activity_at, recent_message_ids)
     values (?, ?, ?, ?)`,
    [roomId, spaceId, lastActivityAt ?? Date.now(), "[]"],
  );
}

/**
 * Seed a read position in the readstate DB.
 */
export function seedReadPosition(
  db: Database,
  userDid: string,
  roomId: string,
  seenUpTo: string,
  unreadCount?: number,
): void {
  // The readstate DB is ATTACHed as `readstate`, so we write through the
  // main DB connection.
  db.run(
    `insert or ignore into readstate.read_positions (user_did, room_id, seen_up_to, unread_count)
     values (?, ?, ?, ?)`,
    [userDid, roomId, seenUpTo, unreadCount ?? 0],
  );
}
