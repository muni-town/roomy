/**
 * Debug endpoint: GET /debug/materialize-space?did=<streamDid>[&wait=backfill]
 *
 * Lazily creates a `SpaceMaterializer` for the given space (idempotent — the
 * registry caches per stream) and returns its current state:
 *
 *   - `cursor`: the persisted `comp_space.backfilled_to` (post-application).
 *   - `stats`:  cumulative apply counts across all batches handled so far.
 *   - `backfillSettled`: whether the initial backfill subscription has
 *     reached completion.
 *
 * If `wait=backfill` is supplied, the response is delayed until the initial
 * backfill resolves (or the Leaf timeout warning fires inside ConnectedSpace).
 *
 * Admin-only: caller must hold a valid inter-service JWT for a DID listed in
 * `APPSERVER_ADMIN_DIDS`.
 */

import { StreamDid, type } from "@roomy-space/sdk";
import { withAdmin } from "../admin.ts";
import { readBackfilledTo } from "../materialization/SpaceMaterializer.ts";
import { getOrCreateMaterializer } from "../materialization/registry.ts";
import { openDb } from "../db/db.ts";

export async function handleDebugMaterializeSpace(
  req: Request,
): Promise<Response> {
  return withAdmin(req, async () => {
    const url = new URL(req.url);
    const did = url.searchParams.get("did");
    if (!did) {
      return Response.json(
        { error: "BadRequest", message: "missing 'did' query parameter" },
        { status: 400 },
      );
    }

    const parsed = StreamDid(did);
    if (parsed instanceof type.errors) {
      return Response.json(
        {
          error: "BadRequest",
          message: `invalid stream DID: ${parsed.summary}`,
        },
        { status: 400 },
      );
    }

    const wait = url.searchParams.get("wait");

    try {
      const mat = await getOrCreateMaterializer(parsed);

      let backfillSettled = false;
      if (wait === "backfill") {
        await mat.backfillDone;
        backfillSettled = true;
      } else {
        // Best-effort: peek at whether the promise has already settled.
        // We attach a handler that flips the flag, then yield once.
        mat.backfillDone.then(() => {
          backfillSettled = true;
        });
        await new Promise((r) => setImmediate(r));
      }

      // Drain in-flight batches so the stats and cursor we report reflect
      // everything that has arrived so far, not a snapshot mid-batch.
      await mat.drain();

      return Response.json({
        streamDid: parsed,
        cursor: readBackfilledTo(openDb(), parsed),
        stats: mat.getStats(),
        backfillSettled,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: "MaterializeFailed", message },
        { status: 500 },
      );
    }
  });
}
