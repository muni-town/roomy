/**
 * Project a decoded spec AuthState into SQLite rows so `access.ts` queries
 * see the same world as the spec.
 *
 * Projection contract: the harness creates a fresh in-memory DB, calls
 * `project(db, spec)`, then queries `access.ts`. Nothing else writes to the
 * DB. So a room exists in the DB iff it exists in `spec.rooms`, etc.
 *
 * `comp_invite` is not projected — `access.ts` doesn't read it, and the
 * spec doesn't track creator/event-ulid metadata that the table requires.
 */

import type { Database } from "bun:sqlite";
import {
  isChannel,
  isThread,
  parentOf,
  permissionToString,
  type AuthState,
  type RoleId,
  type RoomId,
  type UserId,
} from "./types.ts";

/** Default space DID used by the harness. Matches access.test.ts conventions. */
export const SPACE_ID = "did:web:space.example";

export interface ProjectOptions {
  spaceId?: string;
}

export function project(
  db: Database,
  spec: AuthState,
  opts: ProjectOptions = {},
): void {
  const spaceId = opts.spaceId ?? SPACE_ID;

  // 1. Space entity.
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    spaceId,
    spaceId,
  ]);
  db.run("insert into comp_space (entity) values (?)", [spaceId]);

  // 1a. User entities. `edges` has FK on both head and tail → each did
  //     referenced by member/admin/role edges must have an entity row.
  //     Project every user mentioned anywhere in the spec state.
  const seenUsers = new Set<string>();
  const remember = (did: string) => {
    if (seenUsers.has(did)) return;
    seenUsers.add(did);
    db.run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [did, did],
    );
  };
  for (const did of spec.admins) remember(did);
  for (const did of spec.members) remember(did);
  for (const did of spec.bans) remember(did);
  for (const [, role] of spec.roles) {
    for (const did of role.members) remember(did);
  }

  // 2. Rooms (entities + comp_room). Channels carry default_access; threads
  //    set default_access=null so resolveRoom() inherits from canonical parent.
  for (const [roomId, room] of spec.rooms) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      roomId,
      spaceId,
    ]);
    if (isChannel(room)) {
      db.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', ?, ?)",
        [
          roomId,
          permissionToString(room.value.defaultPermission),
          room.value.deleted ? 1 : 0,
        ],
      );
    } else if (isThread(room)) {
      db.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.thread', null, ?)",
        [roomId, room.value.deleted ? 1 : 0],
      );
    }
  }

  // 3. Canonical parent links (channel → thread).
  for (const [roomId, room] of spec.rooms) {
    const parent = parentOf(room);
    if (parent === null) continue;
    db.run(
      `insert into edges (head, tail, label, payload)
         values (?, ?, 'link', json_object('canonical_parent', 1))`,
      [parent, roomId],
    );
  }

  // 4. Membership / admin edges.
  for (const did of spec.members) {
    db.run(
      "insert into edges (head, tail, label) values (?, ?, 'member')",
      [spaceId, did satisfies UserId],
    );
  }
  for (const did of spec.admins) {
    db.run(
      "insert into edges (head, tail, label) values (?, ?, 'admin')",
      [spaceId, did],
    );
  }

  // 5. Bans.
  for (const did of spec.bans) {
    db.run(
      "insert into comp_bans (entity, user_did) values (?, ?)",
      [spaceId, did],
    );
  }

  // 6. Roles + member assignments + per-room permissions.
  //    `None` permissions in the spec map to "no grant" — we skip inserting
  //    them, which is equivalent (the role_rooms CHECK only allows
  //    'read'/'readwrite' anyway).
  for (const [roleId, role] of spec.roles) {
    db.run(
      "insert into roles (id, stream_id, deleted) values (?, ?, 0)",
      [roleId satisfies RoleId, spaceId],
    );

    for (const userId of role.members) {
      db.run(
        "insert into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
        [userId, roleId, spaceId],
      );
    }

    for (const [roomId, perm] of role.channelPermissions) {
      const permStr = permissionToString(perm);
      if (permStr === "none") continue;
      db.run(
        "insert into role_rooms (role_id, room_id, stream_id, permission) values (?, ?, ?, ?)",
        [roleId, roomId satisfies RoomId, spaceId, permStr],
      );
    }
  }
}
