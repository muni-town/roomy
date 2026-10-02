/**
 * Per-call E2EE keys.
 *
 * The properties that matter are that a key is created once per call (a second
 * join reads the same key, or the two sides cannot talk), that it is not a
 * function of anything guessable, and that ending the call destroys it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { ensureCallE2eeKey, shredCallE2eeKey } from "../voice/e2ee.ts";

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
});

afterEach(() => {
  closeDb();
});

describe("call E2EE keys", () => {
  test("creates a 256-bit key on first use", async () => {
    const key = await ensureCallE2eeKey("call-1");
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  test("is stable for a call, so a second join reads the same key", async () => {
    const first = await ensureCallE2eeKey("call-1");
    const second = await ensureCallE2eeKey("call-1");
    expect(second).toBe(first);
  });

  test("a different call gets a different key", async () => {
    expect(await ensureCallE2eeKey("call-1")).not.toBe(
      await ensureCallE2eeKey("call-2"),
    );
  });

  test("shredding removes it, and a later join mints a new one", async () => {
    const original = await ensureCallE2eeKey("call-1");
    await shredCallE2eeKey("call-1");

    const row = await openReadStateDb()
      .query(`select key from voice_call_keys where call_id = ?`)
      .get<{ key: string }>("call-1");
    expect(row).toBeNull();

    const recreated = await ensureCallE2eeKey("call-1");
    expect(recreated).not.toBe(original);
  });

  test("shredding an absent key is a no-op", async () => {
    await shredCallE2eeKey("never-existed");
    expect(await ensureCallE2eeKey("never-existed")).toBeTruthy();
  });
});
