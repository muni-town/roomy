/**
 * Feature flag query helpers, backed by the read-state DB (`readstate.*`).
 *
 * All flags default to false. A flag is enabled for a user iff:
 *   `global_enabled = 1`  OR  the user's DID is in `feature_flag_assignments`.
 */

import type { DbLike } from "../db/types.ts";
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS } from "../featureFlags.ts";
import { XrpcError } from "../xrpc/errors.ts";

export interface FlagState {
  key: string;
  description: string;
  globalEnabled: boolean;
  assignedDids: string[];
}

/**
 * Return the keys of all registered flags that are enabled for `userDid`.
 * A flag is enabled if `global_enabled = 1` or the user has an assignment row.
 */
export async function getEnabledFlagsForUser(
  db: DbLike,
  userDid: string,
): Promise<string[]> {
  const rows = await db
    .query(
      `select f.key from readstate.feature_flags f
       where f.global_enabled = 1
       union
       select a.flag_key from readstate.feature_flag_assignments a
       where a.user_did = ?`,
    )
    .all<{ key: string }>(userDid);

  const enabled = new Set(rows.map((r) => r.key));
  // Only return keys that are still registered in code
  return FEATURE_FLAGS.filter((f) => enabled.has(f.key)).map((f) => f.key);
}

/**
 * Return the full state of every registered flag: key, description, global
 * status, and the list of assigned DIDs. Used by the admin endpoints.
 */
export async function getAllFlagState(db: DbLike): Promise<FlagState[]> {
  // Fetch global flags
  const globalRows = await db
    .query(
      "select key, global_enabled from readstate.feature_flags",
    )
    .all<{ key: string; global_enabled: number }>();

  const globalMap = new Map(
    globalRows.map((r) => [r.key, r.global_enabled === 1]),
  );

  // Fetch all assignments
  const assignRows = await db
    .query(
      "select flag_key, user_did from readstate.feature_flag_assignments order by flag_key, user_did",
    )
    .all<{ flag_key: string; user_did: string }>();

  const assignMap = new Map<string, string[]>();
  for (const r of assignRows) {
    const list = assignMap.get(r.flag_key);
    if (list) {
      list.push(r.user_did);
    } else {
      assignMap.set(r.flag_key, [r.user_did]);
    }
  }

  return FEATURE_FLAGS.map((def) => ({
    key: def.key,
    description: def.description,
    globalEnabled: globalMap.get(def.key) ?? false,
    assignedDids: assignMap.get(def.key) ?? [],
  }));
}

/**
 * Set the global-enabled flag for a feature flag key.
 * Upserts the `feature_flags` row.
 */
export async function setFlagGlobal(
  db: DbLike,
  key: string,
  enabled: boolean,
): Promise<void> {
  await db.run(
    `insert into readstate.feature_flags (key, global_enabled, updated_at)
     values (?, ?, (unixepoch() * 1000))
     on conflict(key) do update set
       global_enabled = excluded.global_enabled,
       updated_at = excluded.updated_at`,
    key,
    enabled ? 1 : 0,
  );
}

/**
 * Replace the per-user DID assignments for a flag key.
 * Deletes existing assignments and inserts the new set in a transaction.
 */
export async function setFlagAssignments(
  db: DbLike,
  key: string,
  dids: string[],
): Promise<void> {
  await db.transaction([
    {
      type: "run",
      sql: "delete from readstate.feature_flag_assignments where flag_key = ?",
      params: [key],
    },
    ...dids.map((did) => ({
      type: "run" as const,
      sql: `insert into readstate.feature_flag_assignments (flag_key, user_did, updated_at)
            values (?, ?, (unixepoch() * 1000))`,
      params: [key, did],
    })),
  ]);
}

/**
 * Reset a flag to its default state: global off, no assignments.
 * Deletes the `feature_flags` row and all assignment rows.
 */
export async function clearFlag(db: DbLike, key: string): Promise<void> {
  await db.transaction([
    {
      type: "run",
      sql: "delete from readstate.feature_flags where key = ?",
      params: [key],
    },
    {
      type: "run",
      sql: "delete from readstate.feature_flag_assignments where flag_key = ?",
      params: [key],
    },
  ]);
}

/**
 * Validate that a flag key is registered in the code registry.
 * Throws XrpcError(400) if not found.
 */
export function requireRegisteredFlag(key: string): void {
  if (!FEATURE_FLAG_KEYS.has(key)) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Unknown flag key: "${key}". Registered flags: ${[...FEATURE_FLAG_KEYS].join(", ") || "(none)"}`,
    );
  }
}
