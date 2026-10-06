import { describe, expect, it } from "vitest";

import {
  classifyMediaDeviceFailure,
  connectionErrorMessage,
  mediaDeviceErrorMessage,
  redactLiveKitError,
} from "./voice-errors";
import { SCOPE_MISSING_ERROR_NAME } from "../scope-guard";

/** A DOMException-shaped error, which is what getUserMedia rejects with. */
function namedError(name: string, message = ""): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("classifyMediaDeviceFailure", () => {
  it("reads a blocked permission from the DOMException name", () => {
    expect(classifyMediaDeviceFailure(namedError("NotAllowedError"))).toBe("permission-denied");
    expect(classifyMediaDeviceFailure(namedError("SecurityError"))).toBe("permission-denied");
  });

  it("reads a blocked permission from a message-only signal", () => {
    expect(classifyMediaDeviceFailure(namedError("Error", "Permission denied"))).toBe(
      "permission-denied",
    );
  });

  it("reads a missing device", () => {
    expect(classifyMediaDeviceFailure(namedError("NotFoundError"))).toBe("not-found");
    expect(classifyMediaDeviceFailure(namedError("Error", "DevicesNotFoundError"))).toBe(
      "not-found",
    );
  });

  it("reads a device held by another application", () => {
    expect(classifyMediaDeviceFailure(namedError("NotReadableError"))).toBe("in-use");
    expect(classifyMediaDeviceFailure(namedError("Error", "TrackStartError"))).toBe("in-use");
  });

  it("reads an unsupported constraint", () => {
    expect(classifyMediaDeviceFailure(namedError("OverconstrainedError"))).toBe("constraint");
  });

  it("keeps an aborted request separate from an unknown failure", () => {
    expect(classifyMediaDeviceFailure(namedError("AbortError"))).toBe("aborted");
    expect(classifyMediaDeviceFailure(namedError("SomethingElse"))).toBe("unknown");
    expect(classifyMediaDeviceFailure("plain string")).toBe("unknown");
  });
});

describe("mediaDeviceErrorMessage", () => {
  it("says the user is in the call when the microphone fails on join", () => {
    const message = mediaDeviceErrorMessage(
      "microphone",
      namedError("NotAllowedError"),
      "joining",
    );
    expect(message.title).toBe("Joined muted");
    expect(message.description).toMatch(/You are in the call/);
  });

  it("gives cause-specific advice for each failure kind", () => {
    expect(mediaDeviceErrorMessage("microphone", namedError("NotFoundError"), "joining").description).toMatch(
      /no microphone was found/i,
    );
    expect(mediaDeviceErrorMessage("microphone", namedError("NotReadableError"), "joining").description).toMatch(
      /another app is using/i,
    );
  });

  it("phrases a failed unmute as a retry, not as being in the call", () => {
    const message = mediaDeviceErrorMessage("microphone", namedError("NotAllowedError"), "switching");
    expect(message.title).toBe("Microphone blocked");
    expect(message.description).not.toMatch(/You are in the call/);
  });

  it("names the speaker as the device on an output-switch failure", () => {
    const message = mediaDeviceErrorMessage("speaker", namedError("NotAllowedError"), "switching");
    expect(message.title).toMatch(/speaker/i);
  });
});

describe("connectionErrorMessage", () => {
  it("explains an E2EE-unsupported browser rather than offering a retry", () => {
    const message = connectionErrorMessage(namedError("Error", "failed to init E2EE cryptor"));
    expect(message.title).toBe("Voice not supported here");
  });

  it("names the missing permission, not the transport, on a scope-miss", () => {
    const message = connectionErrorMessage({
      error: SCOPE_MISSING_ERROR_NAME,
      status: 403,
      message: "Missing required scope: rpc:space.roomy.voice.join?aud=*",
    });
    expect(message.title).toBe("Voice permission missing");
  });

  it("falls back to a reachability explanation", () => {
    const message = connectionErrorMessage(namedError("Error", "signal connection closed"));
    expect(message.title).toBe("Could not join the call");
  });
});

describe("redactLiveKitError", () => {
  it("scrubs a token in a URL", () => {
    const redacted = redactLiveKitError(
      namedError("Error", "failed wss://lk.test?access_token=secret-token&join_request=x"),
    );
    expect(redacted).not.toContain("secret-token");
    expect(redacted).toContain("access_token=<redacted>");
  });

  it("scrubs a bare JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6e319.signature";
    const redacted = redactLiveKitError(namedError("Error", `connect failed for ${jwt}`));
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain("<jwt-redacted>");
  });
});
