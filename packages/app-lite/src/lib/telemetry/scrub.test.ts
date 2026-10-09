/**
 * Tests for the telemetry URL scrub.
 *
 * An error thrown by `@happyview/oauth-client`'s fetchHandler embeds the full
 * request URL in its message. For `com.atproto.server.getServiceAuth` that URL
 * carries `aud`/`exp`/`lxm` — a signed capability — and app-lite logs the error
 * object whole, while Faro's ConsoleInstrumentation forwards every `console.*`
 * line off the device. These tests pin that no such URL survives to the
 * telemetry payload, and that the host (what a URL in a log line is read for)
 * does.
 *
 * Written against `node:test` + `node:assert` so the file runs under both
 * `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { redactUrls, scrubTelemetryItem } from "./scrub.ts";

const PDS = "https://bsky.social";
const SERVICE_AUTH_URL =
  `${PDS}/xrpc/com.atproto.server.getServiceAuth` +
  "?aud=did%3Aweb%3Aapi.roomy.space&exp=1759983600&lxm=space.roomy.auth.recordScopeGrant";

/** The message shape the installed oauth client throws. */
const FETCH_HANDLER_MESSAGE =
  "fetchHandler failed: TypeError: Failed to fetch\n\n" +
  `DEBUG: _fetch type: function, toString: (o,s)=>fetch(o,s), url: ${SERVICE_AUTH_URL}`;

describe("redactUrls", () => {
  test("replaces a service-auth URL with its host", () => {
    const redacted = redactUrls(FETCH_HANDLER_MESSAGE);
    assert.ok(!redacted.includes("https://"), "no URL left in the line");
    assert.ok(!redacted.includes("exp=1759983600"), "no signed query params");
    assert.ok(!redacted.includes("getServiceAuth"), "no path");
    assert.ok(redacted.includes("bsky.social"), "the host is what remains");
    assert.ok(redacted.includes("DEBUG: _fetch type: function"), "the rest of the message is kept");
  });

  test("redacts every URL in a multi-URL line", () => {
    const redacted = redactUrls(`first ${PDS}/a?exp=1 then wss://relay.roomy.space/b?ticket=abc`);
    assert.equal(redacted, "first bsky.social then relay.roomy.space");
  });

  test("keeps sentence punctuation out of the URL", () => {
    assert.equal(redactUrls(`see ${PDS}/a?b=c.`), "see bsky.social.");
    assert.equal(redactUrls(`(${PDS}/a?b=c)`), "(bsky.social)");
    assert.equal(redactUrls(`url: ${SERVICE_AUTH_URL}`.concat("\n")), "url: bsky.social\n");
  });

  test("leaves text without a URL alone", () => {
    const line = "Sync connect failed: WebSocket closed before open: code=1006";
    assert.equal(redactUrls(line), line);
    assert.equal(redactUrls("path/to/x?exp=1"), "path/to/x?exp=1");
  });
});

describe("scrubTelemetryItem", () => {
  test("scrubs a console-captured log line", () => {
    const item = scrubTelemetryItem({
      type: "log",
      payload: {
        message: `Failed to record scope grant: Error: ${FETCH_HANDLER_MESSAGE}`,
        level: "warn",
        timestamp: "2026-10-09T00:00:00.000Z",
      },
      meta: { page: { url: "https://roomy.space/space/did:plc:x" } },
    });

    assert.ok(!item.payload.message.includes("https://"));
    assert.ok(item.payload.message.includes("bsky.social"));
    assert.equal(item.payload.level, "warn");
    assert.equal(item.meta.page.url, "https://roomy.space/space/did:plc:x");
  });

  test("scrubs an exception value, its stack frames, and its context", () => {
    const item = scrubTelemetryItem({
      type: "exception",
      payload: {
        type: "Error",
        value: FETCH_HANDLER_MESSAGE,
        stacktrace: {
          frames: [{ filename: `${PDS}/xrpc/x?exp=1`, function: "fetchHandler", lineno: 3 }],
        },
        context: { hint: `retry against ${SERVICE_AUTH_URL}`, attempt: "2" },
      },
      meta: { browser: { name: "Chrome" } },
    });

    assert.ok(!item.payload.value.includes("https://"));
    assert.ok(item.payload.value.includes("bsky.social"));
    assert.equal(item.payload.stacktrace.frames[0]!.filename, "bsky.social");
    assert.equal(item.payload.stacktrace.frames[0]!.function, "fetchHandler");
    assert.equal(item.payload.context.hint, "retry against bsky.social");
    assert.equal(item.payload.context.attempt, "2");
  });

  test("passes non-string leaves and non-plain objects through", () => {
    const when = new Date(0);
    const err = new Error(`boom ${PDS}/x?exp=1`);
    const item = scrubTelemetryItem({
      type: "log",
      payload: { message: "ok", count: 3, flag: false, missing: null, when, err },
    });

    assert.equal(item.payload.count, 3);
    assert.equal(item.payload.flag, false);
    assert.equal(item.payload.missing, null);
    assert.equal(item.payload.when, when);
    assert.equal(item.payload.err, err);
  });
});
