/**
 * Delivery retry: a transient failure is re-attempted, and a device that keeps
 * failing is written off.
 *
 * A transport separates "the device is dead" (`gone`) from "the attempt
 * failed" (`retry`). Only the second is worth another try, and the retry state
 * lives on the subscription row so a pending re-attempt survives a restart and
 * is readable from diagnostics.
 *
 * The sweep is driven directly with an injected `now`, so a backoff is
 * exercised without waiting for it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  deliverPayload,
  _resetPushDispatcher,
  _runPushRetrySweep,
  pushDispatcherStats,
} from "./dispatcher.ts";
import { maxRetryAttempts, retryBackoffMs } from "./retry.ts";
import { PUSH_TRANSPORTS, type PushOutcome } from "./transports/types.ts";
// Each import installs that draft in `PUSH_TRANSPORTS`; the stubs below
// replace them for the duration of a test.
import "./transports/apn.ts";
import "./transports/fcm.ts";
import "./transports/sse.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import type { DbLike } from "../db/types.ts";

const USER = "did:plc:retry-user";
const ENDPOINT = "retry-device-token";
const STUB_KINDS = ["apns", "fcm", "sse"] as const;
const DRAFTS = {
  apns: PUSH_TRANSPORTS.apns!,
  fcm: PUSH_TRANSPORTS.fcm!,
  sse: PUSH_TRANSPORTS.sse!,
};
const PAYLOAD = {
  type: "message" as const,
  spaceId: "did:plc:space",
  roomId: "01RETRYROOM00000000000000",
  count: 1,
};

/** A transport whose answers are scripted by the test. */
function stubTransport(kind: (typeof STUB_KINDS)[number], reply: PushOutcome) {
  const recorder = { calls: 0, bodies: [] as string[], reply };
  PUSH_TRANSPORTS[kind] = {
    kind,
    isConfigured: () => true,
    async deliver(_target, body) {
      recorder.calls++;
      recorder.bodies.push(body);
      return recorder.reply;
    },
  };
  return recorder;
}

/**
 * The retry lines are the operator-facing record of what happened to a device
 * (a prune after repeated failures is indistinguishable from a `gone` prune
 * except for this), so they are captured rather than printed.
 */
const warnLines: string[] = [];
let warnRestore: (() => void) | undefined;

beforeEach(() => {
  warnLines.length = 0;
  const original = console.warn;
  console.warn = (line: unknown) => {
    warnLines.push(String(line));
  };
  warnRestore = () => {
    console.warn = original;
  };
});

afterEach(async () => {
  await _resetPushDispatcher();
  warnRestore?.();
  for (const kind of STUB_KINDS) PUSH_TRANSPORTS[kind] = DRAFTS[kind];
});

/** Minimal read-state DB carrying just the subscription table. */
function freshDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec(`create table push_subscriptions (
    user_did text not null, endpoint text not null,
    kind text not null default 'webpush',
    p256dh text not null, auth text not null,
    expiration_time integer,
    attempts integer not null default 0,
    retry_after integer,
    last_error text,
    retry_payload text,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    primary key (user_did, endpoint)
  ) strict;`);
  return raw as unknown as DbLike;
}

interface StoredRow {
  endpoint: string | null;
  attempts: number;
  retry_after: number | null;
  last_error: string | null;
  retry_payload: string | null;
}

async function storedRow(db: DbLike, endpoint = ENDPOINT): Promise<StoredRow | null> {
  return db
    .query(
      `select endpoint, attempts, retry_after, last_error, retry_payload
         from push_subscriptions where endpoint = ?`,
    )
    .get<StoredRow>(endpoint);
}

async function seedSubscription(db: DbLike, kind: (typeof STUB_KINDS)[number] = "apns") {
  await upsertSubscription(db, {
    userDid: USER,
    endpoint: ENDPOINT,
    kind,
    expirationTime: null,
  });
}

function retryOutcome(message = "ECONNRESET"): PushOutcome {
  return { outcome: "retry", status: null, error: new Error(message) };
}

describe("push/dispatcher — delivery retry", () => {
  test("a transient failure parks the row with a backoff instead of dropping it", async () => {
    const db = freshDb();
    stubTransport("apns", retryOutcome());
    await seedSubscription(db);

    await deliverPayload(db, USER, PAYLOAD);

    // The transport's own distinction between "dead" and "blip" survives the
    // dispatcher: `retry` keeps the row and records when to try it again.
    const row = (await storedRow(db))!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("ECONNRESET");
    expect(row.retry_payload).toBe(JSON.stringify(PAYLOAD));
    expect(row.retry_after).toBeGreaterThan(Date.now());
    expect(pushDispatcherStats().retryScheduled).toBe(1);
    expect(pushDispatcherStats().failed).toBe(1);
  });

  test("a parked row is re-attempted once its backoff elapses, and settles when it lands", async () => {
    const db = freshDb();
    const recorder = stubTransport("apns", retryOutcome());
    await seedSubscription(db);
    await deliverPayload(db, USER, PAYLOAD);

    // Not yet due: the park is respected.
    await _runPushRetrySweep(db, Date.now());
    expect(recorder.calls).toBe(1);

    recorder.reply = { outcome: "delivered", status: 200 };
    const parked = (await storedRow(db))!;
    await _runPushRetrySweep(db, parked.retry_after!);

    expect(recorder.calls).toBe(2);
    // The re-attempt carries the payload the first attempt failed to send.
    expect(recorder.bodies[1]).toEqual(JSON.stringify(PAYLOAD));
    const settled = (await storedRow(db))!;
    expect(settled.attempts).toBe(0);
    expect(settled.retry_after).toBeNull();
    expect(settled.retry_payload).toBeNull();
    expect(pushDispatcherStats().deliveredOk).toBe(1);
  });

  test("a row that keeps failing transiently is pruned with a GONE-shaped line", async () => {
    const db = freshDb();
    const recorder = stubTransport("apns", retryOutcome());
    await seedSubscription(db);

    const max = maxRetryAttempts();
    await deliverPayload(db, USER, PAYLOAD);
    for (let attempt = 2; attempt <= max; attempt++) {
      const parked = (await storedRow(db))!;
      if (parked === null) break;
      // The backoff widens as attempts accumulate, so each re-attempt is due
      // at a later time — the schedule itself is what spaces them out.
      await _runPushRetrySweep(db, parked.retry_after!);
    }

    // Written off rather than failing forever, and pruned exactly like a
    // `gone` destination.
    expect(await storedRow(db)).toBeNull();
    expect(recorder.calls).toBe(max);
    expect(pushDispatcherStats().prunedFailed).toBe(1);
    expect(warnLines.some((line) => line.includes("GONE (pruned, after="))).toBe(true);
  });

  test("the backoff escalates, so a persistent failure is not retried at a fixed cadence", () => {
    const delays = Array.from({ length: 4 }, (_, i) => retryBackoffMs(i + 1));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    // Past the schedule the delay is capped rather than growing without bound:
    // the ceiling prunes the row on that attempt instead.
    expect(retryBackoffMs(9)).toBe(retryBackoffMs(10));
  });

  test("a new delivery while parked replaces the payload the re-attempt will send", async () => {
    const db = freshDb();
    stubTransport("apns", retryOutcome());
    await seedSubscription(db);
    await deliverPayload(db, USER, PAYLOAD);

    const newer = { ...PAYLOAD, count: 2 };
    await deliverPayload(db, USER, newer);

    // The re-attempt must carry the message the user is waiting for now, not
    // the one that first failed.
    const row = (await storedRow(db))!;
    expect(row.retry_payload).toBe(JSON.stringify(newer));
    expect(row.attempts).toBe(2);
  });

  test("a delivery that lands clears a park from an earlier failure", async () => {
    const db = freshDb();
    const recorder = stubTransport("apns", retryOutcome());
    await seedSubscription(db);
    await deliverPayload(db, USER, PAYLOAD);
    expect((await storedRow(db))!.attempts).toBe(1);

    recorder.reply = { outcome: "delivered", status: 200 };
    await deliverPayload(db, USER, PAYLOAD);

    const row = (await storedRow(db))!;
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
    expect(row.last_error).toBeNull();
  });

  test("a re-attempt that finds the destination gone prunes it", async () => {
    const db = freshDb();
    const recorder = stubTransport("apns", retryOutcome());
    await seedSubscription(db);
    await deliverPayload(db, USER, PAYLOAD);

    recorder.reply = { outcome: "gone", status: 410 };
    await _runPushRetrySweep(db, (await storedRow(db))!.retry_after!);

    expect(await storedRow(db)).toBeNull();
    expect(pushDispatcherStats().gone).toBe(1);
  });

  test("re-registering the device clears its retry state", async () => {
    const db = freshDb();
    stubTransport("apns", retryOutcome());
    await seedSubscription(db);
    await deliverPayload(db, USER, PAYLOAD);
    expect((await storedRow(db))!.attempts).toBe(1);

    // A registration is a fresh claim that the device is reachable, so the
    // attempts spent before it must not count against it.
    await seedSubscription(db);

    const row = (await storedRow(db))!;
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
    expect(row.retry_payload).toBeNull();
  });
});
