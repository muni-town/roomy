/**
 * Every outbound profile call is bounded.
 *
 * `fetchTimeout.test.ts` covers the mechanism; what is left to guard is the
 * *wiring* — a profile fetch that calls the global `fetch` directly is
 * silently unbounded, which is exactly how a stall of this class gets in.
 * So each call site is driven against a server that never answers and asserted
 * to give up rather than hang.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";
import { setHappyView } from "../happyview.ts";
import { defaultGetProfiles, _resetProfileNegativeCache } from "./profiles.ts";
import {
  getProfileFromHappyView,
  getProfilesFromHappyView,
  getRoomyProfileRecord,
} from "./roomyProfile.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");

/** A server that accepts the connection and never responds. */
function blackHole(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const originalTimeout = process.env.PROFILE_FETCH_TIMEOUT_MS;
const originalNodeEnv = process.env.NODE_ENV;
const realFetch = globalThis.fetch;

beforeEach(() => {
  _resetProfileNegativeCache();
  // Short enough to keep the suite fast; the point is that a deadline exists
  // and is enforced, not its exact value.
  process.env.PROFILE_FETCH_TIMEOUT_MS = "150";
});

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.PROFILE_FETCH_TIMEOUT_MS;
  else process.env.PROFILE_FETCH_TIMEOUT_MS = originalTimeout;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  globalThis.fetch = realFetch;
  setHappyView(null);
});

/** Wrap so a rejection is an outcome, not a test failure: either way it returned. */
async function outcome(work: Promise<unknown>): Promise<"returned" | "rejected" | "hung"> {
  const raced = await Promise.race([
    work.then(() => "returned" as const, () => "rejected" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 4000)),
  ]);
  return raced;
}

describe("profile fetch call sites are bounded", () => {
  test("the HappyView batch fetch degrades instead of hanging", async () => {
    const hole = blackHole();
    try {
      const profiles = await getProfilesFromHappyView([ALICE, BOB], {
        endpoint: hole.url,
        clientKey: "hvc_test",
      });
      // Per-chunk catch: a timed-out chunk yields no records for those DIDs,
      // which is the same outcome as "HappyView has no record".
      expect(profiles.size).toBe(0);
    } finally {
      hole.stop();
    }
  });

  test("the HappyView single-DID fetch degrades instead of hanging", async () => {
    const hole = blackHole();
    try {
      expect(await getProfileFromHappyView(ALICE, { endpoint: hole.url, clientKey: "hvc_test" })).toBeNull();
    } finally {
      hole.stop();
    }
  });

  test("the Bluesky appview fetch degrades instead of hanging", async () => {
    // The pipeline skips the appview under `bun test`; defeat that so the real
    // fetch path runs, then redirect the appview at the black hole.
    delete process.env.NODE_ENV;
    const hole = blackHole();
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("api.bsky.app")
        ? realFetch(hole.url, init)
        : realFetch(url, init)) as typeof globalThis.fetch;
    try {
      expect(await defaultGetProfiles([ALICE])).toEqual([]);
    } finally {
      hole.stop();
    }
  });

  test("the PDS record fetch returns instead of hanging", async () => {
    // DID resolution must SUCCEED here, otherwise this test would pass on the
    // resolver's own deadline and never reach the record call. So the DID
    // document is served (pointing its PDS at the black hole) and only the
    // record call is left hanging.
    const hole = blackHole();
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("plc.directory")
        ? Response.json({
            id: ALICE,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: hole.url,
              },
            ],
          })
        : realFetch(url, init)) as typeof globalThis.fetch;
    try {
      expect(await outcome(getRoomyProfileRecord(ALICE))).not.toBe("hung");
    } finally {
      hole.stop();
    }
  });
});
