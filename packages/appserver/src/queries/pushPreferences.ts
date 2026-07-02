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

import type { Database } from "bun:sqlite";
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
export function resolveLevel(
  db: Database,
  userDid: string,
  spaceId: string,
): Level {
  const spaceRow = db
    .query<{ level: string }, [string, string]>(
      "select level from readstate.push_preferences where user_did = ? and space_id = ?",
    )
    .get(userDid, spaceId);
  if (spaceRow) return spaceRow.level as Level;

  const defaultRow = db
    .query<{ level: string }, [string]>(
      "select level from readstate.push_user_default where user_did = ?",
    )
    .get(userDid);
  if (defaultRow) return defaultRow.level as Level;

  return DEFAULT_LEVEL;
}

/** Get the user's full preference set (default + all per-space overrides). */
export function getPushPreferences(
  db: Database,
  userDid: string,
): PushPreferences {
  const defaultRow = db
    .query<{ level: string }, [string]>(
      "select level from readstate.push_user_default where user_did = ?",
    )
    .get(userDid);

  const perSpaceRows = db
    .query<{ space_id: string; level: string }, [string]>(
      "select space_id, level from readstate.push_preferences where user_did = ? order by updated_at desc",
    )
    .all(userDid);

  return {
    default: (defaultRow?.level as Level) ?? DEFAULT_LEVEL,
    perSpace: perSpaceRows.map((r) => ({
      spaceId: r.space_id,
      level: r.level as Level,
    })),
  };
}

/** Set the user-wide default level. */
export function setUserDefault(
  db: Database,
  userDid: string,
  level: Level,
): void {
  db.prepare(
    `insert into readstate.push_user_default (user_did, level, updated_at)
     values (?, ?, (unixepoch() * 1000))
     on conflict(user_did) do update set
       level = excluded.level,
       updated_at = excluded.updated_at`,
  ).run(userDid, level);
}

/** Set (or override) the per-space level for the user. */
export function setSpaceLevel(
  db: Database,
  userDid: string,
  spaceId: string,
  level: Level,
): void {
  db.prepare(
    `insert into readstate.push_preferences (user_did, space_id, level, updated_at)
     values (?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, space_id) do update set
       level = excluded.level,
       updated_at = excluded.updated_at`,
  ).run(userDid, spaceId, level);
}