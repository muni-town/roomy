/**
 * Blocking another account.
 *
 * A block is one `space.roomy.user.block` record in the **blocker's own repo**,
 * keyed by a fresh TID (the lexicon's `key: tid`) — one record per block, so two
 * devices blocking concurrently cannot lose a block to a read-modify-write, and
 * each block keeps its own `createdAt`.
 *
 * The write is direct to the user's own PDS. Every call carries an
 * `atproto-proxy` header naming the user's own PDS service, which is what makes
 * the request a repo write on the user's own account — the same shape the
 * profile edit uses in `routes/user/[user]/+page.svelte`. Nothing is proxied
 * through a space's arbiter: this record belongs to the user, not to a space.
 *
 * The record is public (atproto repos are world-readable), and the appserver
 * never materialises it — it is read back on demand from the PDS, exactly as
 * `space.roomy.user.profile` is.
 *
 * Errors are deliberately NOT translated here. `repo:space.roomy.user.block`
 * arrived with this feature, so a session established before it fails these
 * calls with a resource-server scope-miss, and the caller must be able to see
 * that shape: `isInsufficientScopeError` (used by `guardedXrpc` to offer the
 * consent round-trip, and by the caller to fall back to a sign-in message)
 * inspects the raw error. Wrapping it would hide the very signal the caller
 * needs. {@link blockErrorMessage} is the one piece of copy that belongs with
 * the write, kept pure so it is unit-testable.
 */

import { TID } from "@atproto/common-web";
import type { Agent } from "@atproto/api";
import { auth } from "$lib/auth.svelte";
import { isInsufficientScopeError } from "$lib/scope-guard";

/** The block collection. One record per block, `key: tid`. */
export const BLOCK_COLLECTION = "space.roomy.user.block";

/** A block record read back from a repo. */
export interface BlockRecord {
  /** The record key — needed to remove the block. */
  rkey: string;
  /** DID of the blocked account. */
  subject: string;
}

/**
 * The message to show for a failed block/unblock.
 *
 * A scope-miss gets its own copy: the session was authorised before Roomy asked
 * for block access, so the fix is to authorise again — and saying so is the
 * only honest answer, because retrying cannot grant a scope the token does not
 * hold.
 */
export function blockErrorMessage(err: unknown, action: string): string {
  if (isInsufficientScopeError(err)) {
    return `Roomy does not have permission to manage your blocks on this session. Sign in again to grant it, then retry.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return `Failed to ${action}.`;
}

function requireAgent(): Agent {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");
  return agent;
}

/** Headers that direct a repo call at the user's own PDS. */
function ownRepo(agent: Agent): { headers: Record<string, string> } {
  return { headers: { "atproto-proxy": `${agent.assertDid}#atproto_pds` } };
}

/**
 * Write a block of `subject` to the caller's own repo.
 *
 * The rkey is minted here rather than left to the PDS so the caller learns it
 * without a read-back — it is what {@link unblockUser} needs.
 */
export async function blockUser(
  subject: string,
): Promise<{ rkey: string; uri: string }> {
  const agent = requireAgent();
  const rkey = TID.nextStr();
  const res = await agent.com.atproto.repo.putRecord(
    {
      repo: agent.assertDid,
      collection: BLOCK_COLLECTION,
      rkey,
      record: {
        $type: BLOCK_COLLECTION,
        subject,
        createdAt: new Date().toISOString(),
      },
    },
    ownRepo(agent),
  );
  return { rkey, uri: res.data.uri };
}

/** Remove the block stored at `rkey` from the caller's own repo. */
export async function unblockUser(rkey: string): Promise<void> {
  const agent = requireAgent();
  await agent.com.atproto.repo.deleteRecord(
    {
      repo: agent.assertDid,
      collection: BLOCK_COLLECTION,
      rkey,
    },
    ownRepo(agent),
  );
}

/**
 * Every block in `actor`'s repo, oldest first.
 *
 * The blocks of any account are public data, so reading another account's set
 * needs no special grant; reading the caller's own is covered by the same
 * `repo:` scope the write needs.
 */
export async function listBlocks(actor: string): Promise<BlockRecord[]> {
  const agent = requireAgent();
  const records: BlockRecord[] = [];
  let cursor: string | undefined;
  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: actor,
      collection: BLOCK_COLLECTION,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const rec of res.data.records) {
      const value = rec.value as { subject?: unknown };
      if (typeof value.subject === "string") {
        records.push({
          rkey: rec.uri.split("/").pop() ?? "",
          subject: value.subject,
        });
      }
    }
    cursor = res.data.cursor;
  } while (cursor);
  return records;
}

/** The block `actor` holds on `subject`, or null when there is none. */
export async function findBlock(
  actor: string,
  subject: string,
): Promise<BlockRecord | null> {
  const blocks = await listBlocks(actor);
  return blocks.find((b) => b.subject === subject) ?? null;
}
