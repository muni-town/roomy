/**
 * Schema for `space.roomy.voice.getToken` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.voice.getToken.ts
 *
 * Mints a LiveKit access token for the caller plus the per-call E2EE key, so
 * the client can connect to the SFU directly. `livekitUrl` is returned beside
 * the token because the appserver is the only component that knows the SFU
 * endpoint; the client must not hard-code it.
 *
 * When LiveKit is unconfigured every field is null — the caller renders no
 * call UI. `e2eeKey` is null whenever LiveKit is unconfigured; it is present
 * with a token otherwise (E2EE is on for every call).
 */
import { type } from "arktype";

export const NSID = "space.roomy.voice.getToken" as const;

export const Params = type({ roomId: "string" });

export const Response = type({
  token: "string | null",
  callId: "string | null",
  livekitUrl: "string | null",
  e2eeKey: "string | null",
  /** Seconds the token remains valid. Null when LiveKit is unconfigured. */
  ttl: "number | null",
});
