/**
 * Media-device failures, classified so the UI can say what to do about them.
 *
 * A `getUserMedia` rejection is a `DOMException` whose `name`/`message` are
 * the only thing distinguishing "you clicked Block" from "no microphone is
 * plugged in" from "another app holds the device" — and each of those has a
 * different fix. The classification is a pure function over the error so it
 * can be unit-tested without a browser, and the message mapping is kept
 * beside it so every call site offers the same advice for the same failure.
 *
 * `aborted` is deliberately separate from `unknown`: the browser aborts a
 * `getUserMedia` that the page itself cancelled, which is not a device
 * problem and must not be reported as one.
 */

import { isInsufficientScopeError } from "../scope-guard";

export type MediaDeviceFailureKind =
  | "permission-denied"
  | "not-found"
  | "in-use"
  | "constraint"
  | "aborted"
  | "unknown";

/** Which device the failure concerns, so the message names the right one. */
export type MediaDeviceTarget = "microphone" | "speaker";

/**
 * The failure class behind a rejected device operation.
 *
 * Matches on the name and message together: browsers disagree about which of
 * the two carries the signal (Chrome reports `NotAllowedError` for a blocked
 * permission and `NotFoundError` for a missing device, but a device that is
 * gone can also surface as a message-only `DevicesNotFoundError`).
 */
export function classifyMediaDeviceFailure(err: unknown): MediaDeviceFailureKind {
  const name = err instanceof Error ? err.name.toLowerCase() : "";
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const signal = `${name} ${message}`;

  if (
    signal.includes("notallowed") ||
    signal.includes("permissiondenied") ||
    signal.includes("permission denied") ||
    signal.includes("securityerror")
  ) {
    return "permission-denied";
  }
  if (
    signal.includes("notfound") ||
    signal.includes("devicesnotfound") ||
    signal.includes("device not found") ||
    signal.includes("no device")
  ) {
    return "not-found";
  }
  if (
    signal.includes("notreadable") ||
    signal.includes("trackstarterror") ||
    signal.includes("deviceinuse") ||
    signal.includes("device in use") ||
    signal.includes("already in use")
  ) {
    return "in-use";
  }
  if (signal.includes("overconstrained") || signal.includes("constraint")) {
    return "constraint";
  }
  if (signal.includes("abort")) {
    return "aborted";
  }
  return "unknown";
}

/** A failure worth showing the user, with advice specific to its cause. */
export interface VoiceErrorMessage {
  title: string;
  description: string;
}

/**
 * The message for a device failure, in the context it happened.
 *
 * `joining` separates the two microphone cases: a failure while joining
 * leaves you in the call, listening, with your mic off — so the advice is
 * "you are in the call, here is how to be heard", not "the join failed".
 */
export function mediaDeviceErrorMessage(
  target: MediaDeviceTarget,
  err: unknown,
  context: "joining" | "switching",
): VoiceErrorMessage {
  const kind = classifyMediaDeviceFailure(err);

  if (target === "speaker") {
    return {
      title: "Could not switch speaker",
      description: "Your browser refused that output device. The call continues on the previous one.",
    };
  }

  switch (kind) {
    case "permission-denied":
      return {
        title: context === "joining" ? "Joined muted" : "Microphone blocked",
        description: context === "joining"
          ? "You are in the call, but the browser blocked microphone access. Allow it for this site, then unmute."
          : "The browser blocked microphone access. Allow it for this site, then try again.",
      };
    case "not-found":
      return {
        title: context === "joining" ? "Joined muted" : "No microphone found",
        description: context === "joining"
          ? "You are in the call, but no microphone was found. Connect one, then unmute."
          : "No microphone is available. Connect one and try again.",
      };
    case "in-use":
      return {
        title: context === "joining" ? "Joined muted" : "Microphone is busy",
        description: context === "joining"
          ? "You are in the call, but another app is using your microphone. Close it, then unmute."
          : "Another application is using your microphone. Close it and try again.",
      };
    case "constraint":
      return {
        title: context === "joining" ? "Joined muted" : "Microphone unavailable",
        description: "Your microphone does not support the requested audio settings.",
      };
    case "aborted":
      return {
        title: "Microphone request cancelled",
        description: "The microphone was not started. Try again.",
      };
    case "unknown":
      return {
        title: context === "joining" ? "Joined muted" : "Microphone failed",
        description: "The microphone could not be started.",
      };
  }
}

/**
 * The message for a failure on the way into a call.
 *
 * Three causes reach here and none is fixable with a second press: the session
 * lacks the voice scope (every voice RPC answers 403), the browser cannot do
 * E2EE media (the SFU handshake needs insertable streams), or the SFU is
 * unreachable (WebSocket or ICE failed).
 */
export function connectionErrorMessage(err: unknown): VoiceErrorMessage {
  // A missing voice scope is tested first: the resource server reports it as a
  // 403, and reporting one as an unreachable call server would name a cause the
  // user cannot act on.
  if (isInsufficientScopeError(err)) {
    return {
      title: "Voice permission missing",
      description: "This session is not allowed to use Roomy's voice endpoints. Sign in again once the server grants voice access.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/e2ee|cryptor|encoded transform|insertable stream/i.test(message)) {
    return {
      title: "Voice not supported here",
      description: "This browser cannot do encrypted call audio. Try a recent Chrome, Safari, or Firefox.",
    };
  }
  return {
    title: "Could not join the call",
    description: "The voice server could not be reached. The call may have ended — try again.",
  };
}

/**
 * Redact credentials from a LiveKit failure before it reaches a log.
 *
 * The connect URL can carry the access token, and an error message wrapping
 * that URL would put a usable JWT in the console. Both the bare JWT shape and
 * the query parameters LiveKit uses are scrubbed.
 */
export function redactLiveKitError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/access_token=([^&\s]+)/gi, "access_token=<redacted>")
    .replace(/join_request=([^&\s]+)/gi, "join_request=<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt-redacted>");
}
