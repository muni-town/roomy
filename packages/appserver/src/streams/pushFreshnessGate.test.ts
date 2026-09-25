/**
 * Push freshness gate at the `sendEvents` enqueue site.
 *
 * The Discord bridge's `runBackfill` replays historical Discord messages
 * through the LIVE `sendEvents` path. Each one would otherwise produce an
 * immediate push, because the enqueue site pokes the dispatcher with every
 * createMessage — the only time carried is the event ULID's, which is fresh
 * for a replay.
 *
 * These tests observe the enqueue seam directly (`pokePushDispatcher`), so a
 * replayed day-old message must not produce a job the way a live one does.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { StreamDid, UserDid, newUlid, toBytes } from "@roomy-space/sdk";
import type { Event } from "@roomy-space/sdk";
import { ulid } from "ulidx";
import { openDb, closeDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { StreamManager } from "./StreamManager.ts";
import type { DbLike } from "../db/types.ts";
import type { PushJob } from "../push/types.ts";

const ADMIN = UserDid.assert("did:plc:test-admin");
const STREAM = StreamDid.assert("did:web:pushgate-test.example");
const ROOM = ulid();

/** A createMessage event with a chosen event-ULID time and optional override. */
function messageEvent(opts: { ingestedAt?: number; override?: number; room?: string } = {}): Event {
  const extensions: Record<string, unknown> = {};
  if (opts.override !== undefined) {
    extensions["space.roomy.extension.timestampOverride.v0"] = {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp: opts.override,
    };
  }
  return {
    id: ulid(opts.ingestedAt),
    room: opts.room ?? ROOM,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/markdown", data: toBytes(new TextEncoder().encode("hi")) },
    extensions,
  } as unknown as Event;
}

let db: DbLike;
let sm: StreamManager;
let poked: PushJob[][];

beforeEach(async () => {
  closeDb();
  _resetEmbedSweeper();
  poked = [];
  db = openDb({ path: ":memory:" });
  sm = new StreamManager(db, {
    appserverUrl: "http://test.example",
    getProfiles: undefined,
    // Capture what the write path offers the dispatcher — the observable seam.
    pokePush: (jobs: PushJob[]) => {
      poked.push(jobs);
    },
  });
});

describe("sendEvents — push freshness gate", () => {
  test("live message is poked to the dispatcher", async () => {
    await sm.sendEvents(STREAM, [messageEvent()], ADMIN);
    const jobs = poked.flat();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.roomId).toBe(ROOM);
  });

  test("historical message ingested now is NOT poked", async () => {
    // Replay shape: the event ULID is fresh (ingested this instant) but the
    // message's canonical time is a day old.
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    await sm.sendEvents(
      STREAM,
      [messageEvent({ ingestedAt: Date.now(), override: dayAgo })],
      ADMIN,
    );
    expect(poked.flat()).toHaveLength(0);
  });

  test("a batch with live and replayed messages pokes only the live ones", async () => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const liveRoom = ulid();
    const replayedRoom = ulid();
    await sm.sendEvents(
      STREAM,
      [
        messageEvent({ room: liveRoom }),
        messageEvent({ ingestedAt: Date.now(), override: dayAgo, room: replayedRoom }),
      ],
      ADMIN,
    );
    const jobs = poked.flat();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.roomId).toBe(liveRoom);
  });

  test("bridged message keeps its canonical (override) time on the job", async () => {
    const sentAt = Date.now() - 30_000;
    await sm.sendEvents(
      STREAM,
      [messageEvent({ ingestedAt: Date.now(), override: sentAt })],
      ADMIN,
    );
    const jobs = poked.flat();
    expect(jobs).toHaveLength(1);
    // The job must carry the true message time, not the ingestion time — this
    // is what makes every downstream gate (and the digest batch) age-aware.
    expect(jobs[0]!.canonicalTimestamp).toBe(sentAt);
  });
});
