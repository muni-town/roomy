/**
 * Unit tests for createStreamDid and key storage functions.
 *
 * Uses an in-memory SQLite DB (via openDb) so the events DB schema is
 * initialized. Tests stub globalThis.fetch where needed and clean up
 * env vars in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { StreamDid } from "@roomy-space/sdk";
import { Secp256k1Keypair } from "@atproto/crypto";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { createStreamDid } from "./did.ts";
import { getStreamSigningKey, listStreamOwners, storeStreamKey } from "./keys.ts";
import type { DbLike } from "../db/types.ts";

let db: DbLike;
let origFetch: typeof globalThis.fetch;
let origPlcUrl: string | undefined;
let origUseDidWeb: string | undefined;

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  const testId = Math.random().toString(36).slice(2, 8);
  process.env.EVENTS_DB_PATH = `/tmp/roomy-events-${testId}.sqlite`;

  db = openDb({ path: ":memory:" });

  // Snapshot env vars for restoration in afterEach
  origFetch = globalThis.fetch;
  origPlcUrl = process.env.PLC_DIRECTORY_URL;
  origUseDidWeb = process.env.APPSERVER_USE_DID_WEB;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origPlcUrl === undefined) {
    delete process.env.PLC_DIRECTORY_URL;
  } else {
    process.env.PLC_DIRECTORY_URL = origPlcUrl;
  }
  if (origUseDidWeb === undefined) {
    delete process.env.APPSERVER_USE_DID_WEB;
  } else {
    process.env.APPSERVER_USE_DID_WEB = origUseDidWeb;
  }
  closeDb();
  delete process.env.EVENTS_DB_PATH;
});

// ─── did:web path ────────────────────────────────────────────────────────

describe("did:web path", () => {
  test("creates did:web DID without fetch call and stores key", async () => {
    process.env.APPSERVER_USE_DID_WEB = "true";
    delete process.env.PLC_DIRECTORY_URL;

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const did = await createStreamDid("http://test.example", "did:plc:admin", db);

    expect(did.toString()).toBe("did:web:test.example");
    expect(fetchMock).not.toHaveBeenCalled();

    // DID is stored in dids, did_keys, did_owners
    const key = await getStreamSigningKey(db, did.toString());
    expect(key).not.toBeNull();
    expect(key!.did()).toMatch(/^did:key:/);

    const owners = await listStreamOwners(db, did.toString());
    expect(owners).toEqual(["did:plc:admin"]);
  });
});

// ─── Key roundtrip ──────────────────────────────────────────────────────

describe("key roundtrip", () => {
  test("getStreamSigningKey returns a valid keypair matching the DID", async () => {
    process.env.APPSERVER_USE_DID_WEB = "true";
    delete process.env.PLC_DIRECTORY_URL;

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const did = await createStreamDid("http://test.example", "did:plc:admin", db);
    const didStr = did.toString();

    const keypair = await getStreamSigningKey(db, didStr);
    expect(keypair).not.toBeNull();
    expect(keypair!.did()).toMatch(/^did:key:/);

    const owners = await listStreamOwners(db, didStr);
    expect(owners).toEqual(["did:plc:admin"]);
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────

describe("idempotency", () => {
  test("storeStreamKey called twice does not error and keeps one owner", async () => {
    const did = "did:web:idempotent";
    const owner = "did:plc:admin";
    const key = await Secp256k1Keypair.create({ exportable: true });

    await storeStreamKey(db, did, key, owner);
    // Second call — should not throw
    await storeStreamKey(db, did, key, owner);

    const owners = await listStreamOwners(db, did);
    expect(owners).toEqual([owner]);
  });
});

// ─── PLC path ──────────────────────────────────────────────────────────

describe("PLC path", () => {
  test("creates did:plc DID and calls PLC directory", async () => {
    delete process.env.APPSERVER_USE_DID_WEB;
    process.env.PLC_DIRECTORY_URL = "https://plc.directory";

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    const did = await createStreamDid("http://test.example", "did:plc:admin", db);
    const didStr = did.toString();

    expect(didStr).toMatch(/^did:plc:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = fetchMock.mock.calls[0][0] as string;
    expect(callUrl).toMatch(/^https:\/\/plc\.directory\//);

    // Key is stored
    const key = await getStreamSigningKey(db, didStr);
    expect(key).not.toBeNull();
    expect(key!.did()).toMatch(/^did:key:/);
  });
});

// ─── PLC error ──────────────────────────────────────────────────────────

describe("PLC error", () => {
  test("throws when PLC directory returns error", async () => {
    delete process.env.APPSERVER_USE_DID_WEB;
    process.env.PLC_DIRECTORY_URL = "https://plc.directory";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad"),
    });
    globalThis.fetch = fetchMock;

    await expect(
      createStreamDid("http://test.example", "did:plc:admin", db),
    ).rejects.toThrow("PLC directory error: 400: bad");
  });
});

// ─── Uniqueness ─────────────────────────────────────────────────────────

describe("uniqueness", () => {
  test("two createStreamDid calls with different URLs return different DIDs", async () => {
    process.env.APPSERVER_USE_DID_WEB = "true";
    delete process.env.PLC_DIRECTORY_URL;

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const did1 = await createStreamDid("http://alpha.example", "did:plc:admin", db);
    const did2 = await createStreamDid("http://beta.example", "did:plc:admin", db);

    expect(did1.toString()).toBe("did:web:alpha.example");
    expect(did2.toString()).toBe("did:web:beta.example");
    expect(did1.toString()).not.toBe(did2.toString());

    // Each DID has its own stored key
    const key1 = await getStreamSigningKey(db, did1.toString());
    const key2 = await getStreamSigningKey(db, did2.toString());
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1!.did()).not.toBe(key2!.did());
  });
});
