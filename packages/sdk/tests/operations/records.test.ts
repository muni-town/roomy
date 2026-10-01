/**
 * Own-repo writes must not carry an `atproto-proxy` header.
 *
 * These helpers write to the caller's *own* repo, so naming their own PDS is
 * a self-relay. It is redundant on a direct PDS session and fatal behind
 * HappyView: its forward-time scope check maps any proxied request to
 * `rpc:<nsid>?aud=<did>` and an unproxied one to `repo:<collection>`
 * (happyview `src/xrpc/scope_check.rs`). The `repo:` grant covers these
 * writes; the `rpc:` form does not — so a stray header turns a permitted
 * write into a 403, which is exactly the media-upload failure this guards.
 */

import { describe, it, expect } from "vitest";
import type { Agent } from "@atproto/api";
import {
  createProfileSpaceRecord,
  removeProfileSpaceRecord,
  uploadBlob,
} from "../../src";
import { StreamDid } from "../../src/schema";

const DID = "did:plc:testuser";
const COLLECTION = "space.roomy.space.handle.dev";

interface Captured {
  method: string;
  opts?: { headers?: Record<string, string> };
}

/** A minimal Agent recording every repo call's options. */
function mockAgent(captured: Captured[]): Agent {
  const blob = {
    mimeType: "image/png",
    ref: { toString: () => "bafytestcid" },
    toJSON: () => ({
      $type: "blob",
      ref: { $link: "bafytestcid" },
      mimeType: "image/png",
      size: 3,
    }),
  };
  const record = (method: string) => async (_input: unknown, opts?: Captured["opts"]) => {
    captured.push({ method, opts });
    return method === "uploadBlob" ? { data: { blob } } : { success: true };
  };
  return {
    assertDid: DID,
    com: {
      atproto: {
        repo: {
          uploadBlob: record("uploadBlob"),
          putRecord: record("putRecord"),
          deleteRecord: record("deleteRecord"),
        },
      },
    },
  } as unknown as Agent;
}

describe("own-repo helpers do not proxy", () => {
  it("createProfileSpaceRecord writes unproxied", async () => {
    const captured: Captured[] = [];
    await createProfileSpaceRecord(mockAgent(captured), "did:plc:space" as StreamDid, {
      collection: COLLECTION,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.opts?.headers?.["atproto-proxy"]).toBeUndefined();
  });

  it("removeProfileSpaceRecord writes unproxied", async () => {
    const captured: Captured[] = [];
    await removeProfileSpaceRecord(mockAgent(captured), { collection: COLLECTION });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.opts?.headers?.["atproto-proxy"]).toBeUndefined();
  });

  it("uploadBlob uploads and links the record, neither proxied", async () => {
    const captured: Captured[] = [];
    await uploadBlob(mockAgent(captured), new ArrayBuffer(3), { mimetype: "image/png" });

    expect(captured.map((c) => c.method)).toEqual(["uploadBlob", "putRecord"]);
    for (const call of captured) {
      expect(call.opts?.headers?.["atproto-proxy"]).toBeUndefined();
    }
  });
});
