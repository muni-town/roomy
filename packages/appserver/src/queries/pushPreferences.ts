/**
 * Push preference store, backed by the read-state DB (`readstate.*`).
 *
 * The preference model is a user-wide default (`push_user_default`) plus
 * optional per-space overrides (`push_preferences`). `resolveLevel` is the
 * single entry point the evaluator uses: per-space row wins, else the
 * user-wide default, else {@link DEFAULT_LEVEL} ("engaged").
 *
 * State lives in the read-state DB (not the materialisation DB) so it
 * survives materialisation resets — see `db/readStateDb.ts`.
 */

import type { DbLike } from "../db/types.ts";
import { DEFAULT_LEVEL, type Level } from "../push/level.ts";

export interface PerSpacePreference {
  spaceId: string;
  level: Level;
}

export interface PushPreferences {
  default: Level;
  perSpace: PerSpacePreference[];
}

/**
 * Resolve the effective notification level for `(userDid, spaceId)`:
 * per-space override → user-wide default → {@link DEFAULT_LEVEL}.
 */
export async function resolveLevel(
  db: DbLike,
  userDid: string,
  spaceId: string,
): Promise<Level> {
  const spaceRow = await db.query(
    "select level from readstate.push_preferences where user_did = ? and space_id = ?",
  ).get<{ level: string }>(userDid, spaceId);
  if (spaceRow) return spaceRow.level as Level;

  const defaultRow = await db.query(
    "select level from readstate.push_user_default where user_did = ?",
  ).get<{ level: string }>(userDid);
  if (defaultRow) return defaultRow.level as Level;

  return DEFAULT_LEVEL;
}

/** Get the user's full preference set (default + all per-space overrides). */
export async function getPreferences(
  db: DbLike,
  userDid: string,
): Promise<PushPreferences> {
  const defaultRow = await db.query(
    "select level from readstate.push_user_default where user_did = ?",
  ).get<{ level: string }>(userDid);

  const perSpaceRows = await db.query(
    "select space_id, level from readstate.push_preferences where user_did = ? order by updated_at desc",
  ).all<{ space_id: string; level: string }>(userDid);

  return {
    default: (defaultRow?.level as Level) ?? DEFAULT_LEVEL,
    perSpace: perSpaceRows.map((r) => ({
      spaceId: r.space_id,
      level: r.level as Level,
    })),
  };
}

/** Set the user-wide default level. */
export async function setUserDefault(
  db: DbLike,
  userDid: string,
  level: Level,
): Promise<void> {
  await db.run(
    `insert into readstate.push_user_default (user_did, level, updated_at)
     values (?, ?, (unixepoch() * 1000))
     on conflict(user_did) do update set
       level = excluded.level,
       updated_at = excluded.updated_at`,
    userDid,
    level,
  );
}

/** Set (or override) the per-space level for the user. */
export async function setSpaceLevel(
  db: DbLike,
  userDid: string,
  spaceId: string,
  level: Level,
): Promise<void> {
  await db.run(
    `insert into readstate.push_preferences (user_did, space_id, level, updated_at)
     values (?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, space_id) do update set
       level = excluded.level,
       updated_at = excluded.updated_at`,
    userDid,
    spaceId,
    level,
  );
}
