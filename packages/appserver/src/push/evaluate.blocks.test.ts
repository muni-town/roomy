/**
 * Push and a block.
 *
 * A push payload names its author in the notification title and carries their
 * text in the body, so a push to a reader who hides the author is a full reveal
 * of both identity and content — the one surface where the block would
 * otherwise leak to a device with no app in front of it.
 *
 * Two paths can build such a payload, and they are independent code:
 * `evaluatePush` (the on-event path, one payload per recipient) and the
 * dispatcher's time-based digest sweep (a batch, named after the room's most
 * recent sender). Both are checked here, because a reader who is silent on one
 * still receives a named notification from the other.
 *
 * There is no admin exception: neither path runs with a caller present, so
 * there is no viewer for a reveal to apply to. An admin who blocked someone
 * reads the one message they may reveal by fetching it — they are not pushed
 * it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _blockRefreshesInFlight,
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import { setUserDefault } from "../queries/pushPreferences.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import { evaluatePush } from "./evaluate.ts";
import { _resetPushDispatcher, _runDigestSweep } from "./dispatcher.ts";
import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTarget,
} from "./transports/types.ts";
import "./transports/sse.ts";
import "./transports/webPush.ts";
import { DIGEST_WINDOW_MS } from "../queries/notificationState.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const SPACE = "did:web:space.example" as string;
const CHANNEL = "01CHANNEL00000000000000000";
const MESSAGE_ID = "01MSGBUSYTEST0000000000AA";
const AUTHOR = "did:plc:alice";
const BUSY_READER = "did:plc:bob";
/** Holds the space admin edge and placed the block itself. */
const ADMIN_READER = "did:plc:carol";
const UNBLOCKED_READER = "did:plc:dave";

/** A transport that records what it was asked to deliver. */
interface RecordingTransport {
  calls: Array<{ target: PushTarget; body: string; options: PushDeliveryOptions }>;
}

/**
 * Install a recording transport for the `sse` kind, so a delivery the
 * dispatcher routes is observable without a push service. `sse` is the draft
 * entry with no credentials and no network call, which makes it the right kind
 * to borrow.
 */
function recordDeliveries(): RecordingTransport {
  const recorder: RecordingTransport = { calls: [] };
  const outcome: PushOutcome = { outcome: "delivered", status: 200 };
  PUSH_TRANSPORTS["sse"] = {
    kind: "sse",
    isConfigured: () => true,
    async deliver(target, body, options) {
      recorder.calls.push({ target, body, options });
      return outcome;
    },
  };
  return recorder;
}

const DRAFT_SSE = PUSH_TRANSPORTS["sse"]!;

/**
 * A per-space DB with materialisation tables, and a separate read-state DB —
 * the production split, so a query crossing between them fails loudly instead
 * of passing on a fixture that has both.
 */
function freshDbs(): { spaceDb: DbLike; readStateDb: DbLike } {
  const space = new Database(":memory:");
  space.exec("pragma foreign_keys = on");
  space.exec(readFileSync(join(THIS_DIR, "..", "db", "schema-space.sql"), "utf8"));

  const readState = new Database(":memory:");
  readState.exec("pragma foreign_keys = on");
  readState.exec(readFileSync(join(THIS_DIR, "..", "db", "readStateSchema.sql"), "utf8"));

  return { spaceDb: toAsyncDb(space), readStateDb: toAsyncDb(readState) };
}

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string): BlockRecord => ({
  subject,
  source: "roomy",
  createdAt: null,
});

// ─── Fixture ──────────────────────────────────────────────────────────────

let recorder: RecordingTransport;

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
  _resetPushDispatcher();
  _setTestFetchBlockRecords(async () => []);

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );
  await space.run("insert into comp_info (entity, name) values (?, ?)", [CHANNEL, "general"]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, AUTHOR]);
  await space.run("insert into comp_user (did, handle) values (?, ?)", [AUTHOR, "alice.test"]);
  await space.run("insert into comp_info (entity, name) values (?, ?)", [AUTHOR, "Alice"]);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [MESSAGE_ID, SPACE, CHANNEL, MESSAGE_ID],
  );
  await space.run(
    "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
    [MESSAGE_ID, new TextEncoder().encode("a body the block must withhold"), MESSAGE_ID],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    MESSAGE_ID,
    AUTHOR,
  ]);

  for (const did of [AUTHOR, BUSY_READER, ADMIN_READER, UNBLOCKED_READER]) {
    await space.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
    await space.run("insert or ignore into comp_user (did, handle) values (?, ?)", [did, null]);
    await space.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'member')",
      [SPACE, did],
    );
  }
  // The admin edge is the one that would open a reveal on a read path; it must
  // not open anything here.
  await space.run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, ADMIN_READER],
  );

  await openGlobalDb().run(
    "insert into entity_space (entity_id, space_did) values (?, ?)",
    [CHANNEL, SPACE],
  );
  await openGlobalDb().run(
    "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
    [AUTHOR, "alice.test", "Alice", Date.now()],
  );

  // Every reader is busy — the level that pushes on every message — and has a
  // device, so nothing is skipped for a reason other than the block.
  for (const did of [BUSY_READER, ADMIN_READER, UNBLOCKED_READER]) {
    await setUserDefault(openReadStateDb(), did, "busy");
    await upsertSubscription(openReadStateDb(), {
      userDid: did,
      endpoint: `https://push.test/${did}`,
      // The observed kind: the stub in `beforeEach` replaces this entry, so a
      // delivery routed here is recorded instead of reaching a push service.
      kind: "sse",
      p256dh: "p256dh-key",
      auth: "auth-key",
      expirationTime: null,
    });
  }

  recorder = recordDeliveries();
});

afterEach(async () => {
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  _resetPushDispatcher();
  PUSH_TRANSPORTS["sse"] = DRAFT_SSE;
  closeDb();
});

/** Write `records` into `did`'s stored block set, as the PDS refresh path does. */
async function seedBlocks(did: string, records: BlockRecord[]): Promise<void> {
  _setTestFetchBlockRecords(async () => records);
  await refreshBlockSet(did as UserDid);
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(async () => []);
}

const job = () => ({
  spaceId: SPACE,
  roomId: CHANNEL,
  messageId: MESSAGE_ID,
  authorDid: AUTHOR as UserDid,
  timestamp: Date.now(),
});

describe("push and a block", () => {
  test("a reader who hides nobody is pushed, and the payload names the author", async () => {
    const deliveries = await evaluatePush(openReadStateDb(), openSpaceDb(SPACE), job());

    const recipients = deliveries.map((d) => d.userDid);
    expect(recipients).toContain(UNBLOCKED_READER);
    expect(recipients).toContain(BUSY_READER);

    const payload = deliveries.find((d) => d.userDid === UNBLOCKED_READER)!.payload;
    expect(payload.authorName).toBe("Alice");
    expect(payload.messageContent).toContain("a body the block must withhold");
  });

  test("a reader who blocked the author is skipped before any payload is built", async () => {
    await seedBlocks(BUSY_READER, [block(AUTHOR)]);

    const deliveries = await evaluatePush(openReadStateDb(), openSpaceDb(SPACE), job());

    expect(deliveries.find((d) => d.userDid === BUSY_READER)).toBeUndefined();
    // Nobody else is affected: the block is per-reader.
    expect(deliveries.find((d) => d.userDid === UNBLOCKED_READER)).toBeDefined();
  });

  test("the reverse direction is skipped too — being blocked hides the author", async () => {
    // The author blocked the reader. The reader placed no block, so only the
    // recovered reverse set can answer this.
    await seedBlocks(AUTHOR, [block(BUSY_READER)]);

    const deliveries = await evaluatePush(openReadStateDb(), openSpaceDb(SPACE), job());

    expect(deliveries.find((d) => d.userDid === BUSY_READER)).toBeUndefined();
    expect(deliveries.find((d) => d.userDid === UNBLOCKED_READER)).toBeDefined();
  });

  test("an admin who placed the block is skipped — no push carries a reveal", async () => {
    await seedBlocks(ADMIN_READER, [block(AUTHOR)]);

    const deliveries = await evaluatePush(openReadStateDb(), openSpaceDb(SPACE), job());

    // The admin could reveal this message by fetching it; that is not a licence
    // to notify them of it. Push has no caller, so there is nothing to widen.
    expect(deliveries.find((d) => d.userDid === ADMIN_READER)).toBeUndefined();
    expect(deliveries.find((d) => d.userDid === UNBLOCKED_READER)).toBeDefined();
  });

  test("a hidden author's batch names nobody in a time-based digest either", async () => {
    // The sweep is a second, independent payload builder: it never calls
    // `evaluatePush`, and it names the room's most recent sender.
    await seedBlocks(BUSY_READER, [block(AUTHOR)]);

    const readState = openReadStateDb();
    // A batch whose 1-hour timer has elapsed, so the sweep picks it up.
    await readState.run(
      `insert into notification_state
         (user_did, room_id, first_unseen_at, first_unseen_msg_id, unseen_count, notified)
       values (?, ?, ?, ?, 3, 0)`,
      [BUSY_READER, CHANNEL, Date.now() - DIGEST_WINDOW_MS - 1_000, MESSAGE_ID],
    );

    await _runDigestSweep(readState);

    expect(recorder.calls).toHaveLength(0);
    // The batch is marked notified rather than left due: the reader is not
    // waiting to be told, and a due row would be re-checked every sweep.
    const row = await readState
      .query("select notified from notification_state where user_did = ? and room_id = ?")
      .get<{ notified: number }>([BUSY_READER, CHANNEL]);
    expect(row?.notified).toBe(1);
  });

  test("a reader who hides nobody still receives the time-based digest", async () => {
    const readState = openReadStateDb();
    await readState.run(
      `insert into notification_state
         (user_did, room_id, first_unseen_at, first_unseen_msg_id, unseen_count, notified)
       values (?, ?, ?, ?, 3, 0)`,
      [UNBLOCKED_READER, CHANNEL, Date.now() - DIGEST_WINDOW_MS - 1_000, MESSAGE_ID],
    );

    await _runDigestSweep(readState);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.body).toContain("Alice");
  });
});
