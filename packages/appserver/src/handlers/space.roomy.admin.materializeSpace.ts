/**
 * XRPC: space.roomy.admin.materializeSpace (query).
 *
 * Lazily creates (or returns the cached) `SpaceMaterializer` for the given
 * stream and reports its current state. With `wait=backfill`, awaits the
 * initial backfill before responding.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { StreamDid, type } from "@roomy-space/sdk";
import { requireAdmin } from "../admin.ts";
import { openDb } from "../db/db.ts";
import { readBackfilledTo } from "../materialization/SpaceMaterializer.ts";
import { getOrCreateMaterializer } from "../materialization/registry.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface MaterializeSpaceResult {
  streamDid: string;
  cursor: number;
  backfillSettled: boolean;
  stats: {
    applied: number;
    materializerErrors: number;
    applyErrors: number;
    batches: number;
  };
}

export const materializeSpaceHandler: QueryHandler<
  QueryParams,
  MaterializeSpaceResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const did = params["did"];
  if (typeof did !== "string" || did === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "missing 'did' query parameter",
    );
  }

  const parsed = StreamDid(did);
  if (parsed instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `invalid stream DID: ${parsed.summary}`,
    );
  }

  const wait = params["wait"];
  const mat = await getOrCreateMaterializer(parsed);

  let backfillSettled = false;
  if (wait === "backfill") {
    await mat.backfillDone;
    backfillSettled = true;
  } else {
    // Best-effort: peek at whether the promise has already settled.
    mat.backfillDone.then(() => {
      backfillSettled = true;
    });
    await new Promise((r) => setImmediate(r));
  }

  await mat.drain();

  return {
    streamDid: parsed,
    cursor: readBackfilledTo(openDb(), parsed),
    stats: mat.getStats(),
    backfillSettled,
  };
};
