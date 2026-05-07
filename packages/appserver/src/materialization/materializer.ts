/**
 * Per-event materialiser: turns one decoded Event into a bundle of SQL
 * statements via the SDK's pure `getMaterializer` registry.
 *
 * Mirrors the frontend `packages/app/src/lib/workers/sqlite/materializer.ts`
 * but synchronous (no async channel pipeline) and minus the EdgeLabel/EdgesMap
 * re-declarations — those types live in the SDK and are imported where
 * needed.
 */

import {
  type Event,
  type StreamIndex,
  getDependsOn,
  getMaterializer,
} from "@roomy-space/sdk";

import type {
  MaterializeOpts,
  StatementBundle,
  StatementBundleSuccess,
} from "./types.ts";

/** Run the SDK materialiser for a single event and wrap the result. */
export function materialize(
  event: Event,
  opts: MaterializeOpts,
  idx: StreamIndex,
): StatementBundle {
  const kind = event.$type;

  try {
    const handler = getMaterializer(kind);
    if (!handler) {
      throw new Error(`No materializer found for event kind: ${kind}`);
    }

    const statements = handler({
      ...opts,
      event,
    } as Parameters<typeof handler>[0]);

    const dependsOn = getDependsOn(event);

    return {
      status: "success",
      event,
      eventIdx: idx,
      user: opts.user,
      statements: Array.isArray(statements) ? statements : [statements],
      dependsOn,
    } satisfies StatementBundleSuccess;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error materializing event ${event.id} (${kind}):`, error);
    return {
      status: "error",
      eventId: event.id,
      message,
    };
  }
}
