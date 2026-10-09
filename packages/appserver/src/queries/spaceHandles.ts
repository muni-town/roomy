/**
 * DNS space handles, stored in the global DB (`space_handles`).
 *
 * A space handle is assigned by the space's PDS (or by the domain's DNS) and
 * changes without any on-protocol write, so it is not derivable from the event
 * log. Keeping it in the per-space DB would mean a space replayed from the log
 * silently loses it; this is the same split the global `profiles` table uses
 * for user profiles. The per-space DB holds no copy.
 *
 * Written only by `space.roomy.space.setHandle`, which requires space admin.
 * Reads go through the helpers here so the store is the single place the SQL
 * lives.
 */

import { tryOpenGlobalDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";

/** A space's handle, or `null` when it has none set. */
export async function getSpaceHandle(
  spaceDid: string,
  globalDb?: DbLike,
): Promise<string | null> {
  const db = globalDb ?? tryOpenGlobalDb();
  if (!db) return null;
  const row = await db
    .query("select handle from space_handles where space_did = ?")
    .get<{ handle: string }>(spaceDid);
  return row?.handle ?? null;
}

/**
 * The handles for `spaceDids`, keyed by space DID. Absent keys are spaces with
 * no handle (or, for a process with no global DB, every space).
 *
 * One round-trip for a page of spaces, which is what `getSpaces` needs.
 */
export async function getSpaceHandles(
  spaceDids: readonly string[],
  globalDb?: DbLike,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (spaceDids.length === 0) return out;
  const db = globalDb ?? tryOpenGlobalDb();
  if (!db) return out;
  const placeholders = spaceDids.map(() => "?").join(", ");
  const rows = await db
    .query(
      `select space_did, handle from space_handles where space_did in (${placeholders})`,
    )
    .all<{ space_did: string; handle: string }>(...spaceDids);
  for (const row of rows) out.set(row.space_did, row.handle);
  return out;
}

/**
 * Store `handle` for `spaceDid`, or remove the row when `handle` is `null`.
 * Idempotent.
 */
export async function upsertSpaceHandle(
  spaceDid: string,
  handle: string | null,
  globalDb: DbLike,
): Promise<void> {
  if (handle === null) {
    await globalDb.run("delete from space_handles where space_did = ?", spaceDid);
    return;
  }
  await globalDb.run(
    `insert into space_handles (space_did, handle, updated_at)
     values (?, ?, ?)
     on conflict (space_did) do update set
       handle = excluded.handle,
       updated_at = excluded.updated_at`,
    spaceDid,
    handle,
    Date.now(),
  );
}
