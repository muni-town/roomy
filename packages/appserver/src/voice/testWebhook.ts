/**
 * Test-mode webhook endpoints.
 *
 * These call the same core handler the real webhook calls, bypassing only the
 * HMAC step — which is the step a test cannot produce without minting a signed
 * request from the appserver's own secret. They exist only while
 * `APPSERVER_TEST_MODE=true`: the route is registered inside that branch, so a
 * production process has no code path to reach them.
 *
 * The bypass must not weaken the pipeline it exercises, so everything after
 * validation is identical — the same room-name parsing, the same fact
 * collapsing, the same idempotency.
 */

import type { DbLike } from "../db/types.ts";
import { handleLiveKitWebhook, type LiveKitWebhookPayload } from "./webhook.ts";

export interface TestWebhookOutcome {
  status: number;
  error?: string;
}

/** The test routes, mapped to the LiveKit event each stands for. */
const TEST_EVENTS: Record<string, string> = {
  "call-join": "participant_joined",
  "call-leave": "participant_left",
  "call-room-finished": "room_finished",
};

/**
 * Ingest a test webhook by route name.
 *
 * The body is the same shape LiveKit sends minus the signature: a room name
 * and, for participant events, an identity.
 */
export async function processTestWebhook(
  route: string,
  body: unknown,
  deps: { openSpaceDb?: (spaceId: string) => DbLike } = {},
): Promise<TestWebhookOutcome> {
  const event = TEST_EVENTS[route];
  if (!event) {
    return { status: 404, error: `Unknown test webhook: ${route}` };
  }
  if (typeof body !== "object" || body === null) {
    return { status: 400, error: "Malformed test webhook body" };
  }

  const payload = body as Omit<LiveKitWebhookPayload, "event">;
  try {
    await handleLiveKitWebhook({ ...payload, event }, deps);
  } catch {
    return { status: 500, error: "Webhook handling failed" };
  }
  return { status: 200 };
}
