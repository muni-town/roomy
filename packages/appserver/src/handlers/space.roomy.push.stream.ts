import { openReadStateDb } from "../db/db.ts";
import { holdsPushDispatcher } from "../push/dispatcher.ts";
import { openSseStream } from "../push/sseStream.ts";
import {
  hasSseConnection,
  sseConnectionCount,
} from "../push/transports/sse.ts";
import { selectSubscriptions } from "../queries/pushSubscriptions.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { StreamContext, StreamHandler } from "../xrpc/types.ts";

const SSE_MAX_STREAMS = 2000
const SSE_MAX_AGE_MS = 60 * 60 * 1000
const SSE_TICK_MS = 20_000
const SSE_MAX_QUEUED_FRAMES = 32

export interface PushStreamDeps {
  holdsDispatcher: () => boolean;
  /** if `userDid` has registered `endpoint` as an `sse` device. */
  hasSseSubscription: (userDid: string, endpoint: string) => Promise<boolean>;
  hasConnection: (endpoint: string) => boolean;
  totalStreamCount: () => number;
  limits?: {
    maxStreams: number;
    maxAgeMs: number;
    tickMs: number;
    maxQueuedFrames: number;
  }
}


function overloaded(
  error: string,
  message: string,
  retryAfterSeconds: number,
): Response {
  return Response.json(
    { error, message },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

export function createPushStreamHandler(deps: PushStreamDeps): StreamHandler {

  const limits = deps.limits ?? {
    maxStreams: SSE_MAX_STREAMS,
    maxAgeMs: SSE_MAX_AGE_MS,
    tickMs: SSE_TICK_MS,
    maxQueuedFrames: SSE_MAX_QUEUED_FRAMES,
  }
  return async (req: Request, context: StreamContext): Promise<Response> => {
    if (!deps.holdsDispatcher()) {
      return overloaded(
        "NotDispatcher",
        "This replica does not own push delivery; retry",
        5,
      );
    }

    const userDid = parseUserDid(await context.authenticate());
    if (userDid === null) {
      throw new XrpcError(401, "AuthRequired", "Authentication required");
    }

    const endpoint = context.params["endpoint"];
    if (typeof endpoint !== "string" || endpoint === "") {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Missing or empty query parameter: endpoint",
      );
    }
    if (!(await deps.hasSseSubscription(userDid, endpoint))) {
      throw new XrpcError(
        400,
        "NotRegistered",
        "This endpoint is not registered as an sse device; register it first",
      );
    }

    if (
      !deps.hasConnection(endpoint) &&
      deps.totalStreamCount() >= limits.maxStreams
    ) {
      return overloaded("StreamCapacity", "Stream capacity reached; retry", 30);
    }

    return openSseStream({
      endpoint,
      signal: req.signal,
      maxAgeMs: limits.maxAgeMs,
      tickMs: limits.tickMs,
      maxQueuedFrames: limits.maxQueuedFrames,
      holdsDispatcher: deps.holdsDispatcher,
    });
  };
}

export const pushStreamHandler: StreamHandler = createPushStreamHandler({
  holdsDispatcher: holdsPushDispatcher,
  hasSseSubscription: async (userDid, endpoint) =>
    (await selectSubscriptions(openReadStateDb(), userDid)).some(
      (row) => row.kind === "sse" && row.endpoint === endpoint,
    ),
  hasConnection: hasSseConnection,
  totalStreamCount: sseConnectionCount,
});
