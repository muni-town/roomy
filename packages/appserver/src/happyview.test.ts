/**
 * HappyView authentication and startup visibility.
 *
 * HappyView rejects a request without `X-Client-Key`, and the batch path is
 * the one that carries profile hydration for every reader, so a header
 * missing there silently pushes all profile lookups onto the per-DID Bluesky
 * fallback. The header tests pin both call sites to the same header set; the
 * startup-line tests pin the one signal that says whether the pipeline is on
 * at all.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";
import {
  happyViewHeaders,
  logHappyViewStartup,
  type HappyViewConfig,
} from "./happyview.ts";
import { log } from "./log.ts";
import {
  getProfileFromHappyView,
  getProfilesFromHappyView,
} from "./materialization/roomyProfile.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");

const CONFIG: HappyViewConfig = {
  endpoint: "https://happyview.test",
  clientKey: "hvc_test_key",
  clientSecret: "hvs_test_secret",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture each request's headers, answering with an empty profile list. */
function captureRequests(): { headers: Record<string, string>[] } {
  const captured: { headers: Record<string, string>[] } = { headers: [] };
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    captured.headers.push({ ...(init?.headers as Record<string, string>) });
    return Promise.resolve(Response.json({ profiles: [] }));
  }) as typeof globalThis.fetch;
  return captured;
}

describe("HappyView request headers", () => {
  test("the batch path sends the client key and secret", async () => {
    const captured = captureRequests();
    await getProfilesFromHappyView([ALICE, BOB], CONFIG);
    expect(captured.headers).toHaveLength(1);
    expect(captured.headers[0]).toMatchObject({
      "X-Client-Key": CONFIG.clientKey,
      "X-Client-Secret": CONFIG.clientSecret,
    });
  });

  test("the single-DID path sends the client key and secret", async () => {
    const captured = captureRequests();
    await getProfileFromHappyView(ALICE, CONFIG);
    expect(captured.headers).toHaveLength(1);
    expect(captured.headers[0]).toMatchObject({
      "X-Client-Key": CONFIG.clientKey,
      "X-Client-Secret": CONFIG.clientSecret,
    });
  });

  test("a config without a secret still sends the key", () => {
    expect(happyViewHeaders({ endpoint: CONFIG.endpoint, clientKey: "hvc_k" })).toEqual({
      "X-Client-Key": "hvc_k",
    });
  });
});

describe("HappyView startup line", () => {
  test("configured: one line names the endpoint host, not the credentials", () => {
    const info = spyOn(log, "info");
    try {
      logHappyViewStartup(CONFIG);
      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0]?.[0]);
      expect(line).toContain("[happyview]");
      expect(line).toContain("enabled");
      expect(line).toContain("happyview.test");
      expect(line).not.toContain(CONFIG.clientKey);
      expect(line).not.toContain(CONFIG.clientSecret);
    } finally {
      info.mockRestore();
    }
  });

  test("unconfigured: one line says the pipeline is disabled", () => {
    const info = spyOn(log, "info");
    try {
      logHappyViewStartup(null);
      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0]?.[0]);
      expect(line).toContain("[happyview]");
      expect(line).toContain("disabled");
    } finally {
      info.mockRestore();
    }
  });
});
