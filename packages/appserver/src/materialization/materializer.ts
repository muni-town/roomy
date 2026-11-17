/**
 * Per-event materialiser: turns one decoded Event into a bundle of SQL
 * statements via the SDK's pure `getMaterializer` registry.
 *
 * Synchronous (no async channel pipeline), and it does not re-declare
 * EdgeLabel/EdgesMap — those types live in the SDK and are imported where
 * needed.
 */

import {
  type Event,
  type EventType,
  type StreamIndex,
  type Ulid,
  getDependsOn,
  getMaterializer,
} from "@roomy-space/sdk";

import type {
  MaterializeOpts,
  StatementBundle,
  StatementBundleSuccess,
} from "./types.ts";
import { log } from "../log.ts";

/** Run the SDK materialiser for a single event and wrap the result. */
export function materialize(
  event: Event,
  opts: MaterializeOpts,
  idx: StreamIndex,
): StatementBundle {
  // A decoded payload that carries no `$type` never named a kind: that is a
  // decode failure, not an unknown kind, and the caller decides how loudly to
  // report it (the replayer knows the payload's length, which is the detail
  // that tells a legacy encoding apart from a truncated row). `event` is a
  // raw CBOR decode, so the fields are checked rather than assumed.
  const rawKind: unknown = event.$type;
  const rawId: unknown = event.id;
  const kind = typeof rawKind === "string" ? rawKind : null;
  const eventId = typeof rawId === "string" ? (rawId as Ulid) : null;

  if (kind === null) {
    log.debug(
      `[materialize] event ${eventId ?? "<no id>"} carries no $type — no materialiser to run`,
    );
    return {
      status: "skip",
      eventId,
      reason: "undecodable",
      kind: null,
    };
  }

  // Check if we have a materializer for this event type before attempting
  const handler = getMaterializer(kind as EventType);
  if (!handler) {
    log.warn(`[materialize] no materializer for event ${eventId} (kind: ${kind}) — skipping`);
    return {
      status: "skip",
      eventId,
      reason: "unregistered",
      kind,
    };
  }

  try {
    const statements = handler({
      // A caller with no log behind it (a test, a direct SDK use) gets
      // wall-clock time; every appserver path supplies the entry's instant.
      decidedAt: Date.now(),
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
    log.error(`[materialize] failed for event ${eventId} (${kind}): ${message}`);
    return {
      status: "error",
      eventId: eventId ?? ("" as Ulid),
      message,
    };
  }
}
