import type { Bundle, StreamIndex } from "../types";
import type { SqlStatement } from "./types";
import {
  Event,
  type Ulid,
  UserDid,
  StreamDid,
  getMaterializer,
} from "@roomy/sdk";
import { getDependsOn } from "@roomy/sdk";

// UTILS

/**
 * Helper to wrap materializer logic and automatically create success/error bundles.
 * This eliminates the repetitive bundle-wrapping code in each materializer.
 */
function bundleSuccess(
  event: Event,
  idx: StreamIndex,
  user: UserDid,
  statements: SqlStatement | SqlStatement[],
  dependsOn: Ulid[],
): Bundle.Statement {
  return {
    status: "success",
    event: event,
    eventIdx: idx,
    user,
    statements: Array.isArray(statements) ? statements : [statements],
    dependsOn,
  };
}

/**
 * Helper to create an error bundle with a consistent format.
 */
function bundleError(
  event: Event,
  error: Error | string,
): Bundle.StatementError {
  return {
    eventId: event.id,
    status: "error",
    message: typeof error === "string" ? error : error.message,
  };
}

/**
 * Main materialize function called by the sqlite worker for each event.
 */
export async function materialize(
  event: Event,
  opts: { streamId: StreamDid; user: UserDid },
  idx: StreamIndex,
): Promise<Bundle.Statement> {
  const kind = event.$type;

  try {
    const handler = getMaterializer(kind);
    if (!handler) {
      throw new Error(`No materializer found for event kind: ${kind}`);
    }

    const statements = handler({
      ...opts,
      event,
    } as any);

    // some events depend on other events which must be materialized first
    const dependsOn = getDependsOn(event);

    return bundleSuccess(event, idx, opts.user, statements, dependsOn);
  } catch (error) {
    console.error(`Error materializing event ${event.id}:`, error);
    return bundleError(event, error instanceof Error ? error : String(error));
  }
}

function edgePayload<EdgeLabel extends keyof EdgesWithPayload>(
  payload: EdgesMap[EdgeLabel],
) {
  return JSON.stringify(payload);
}

export type EdgeLabel = "member" | "ban" | "link";

type EntityId = string;

export interface EdgeBan {
  reason: string;
  banned_by: EntityId;
}

export interface EdgeMember {
  // delegation?: string;
  can: "read" | "post" | "admin";
}

interface EdgesWithPayload {
  ban: EdgeBan;
  member: EdgeMember;
}

export type EdgesMap = {
  [K in Exclude<EdgeLabel, keyof EdgesWithPayload>]: null;
} & EdgesWithPayload;

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], EntityId];
};
