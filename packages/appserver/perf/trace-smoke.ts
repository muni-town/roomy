#!/usr/bin/env bun
/**
 * Tracing smoke test.
 *
 * Boots the appserver with OTLP tracing enabled, seeds a space in memory,
 * and exercises the three instrumented endpoints (getThreads, getMessages,
 * sendEvents) so real spans are exported to a collector.
 *
 * Point it at a collector and check the span output:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 bun run perf/trace-smoke.ts
 */
import { newUlid, UserDid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openGlobalDb } from "../src/db/db.ts";
import { _resetEmbedSweeper } from "../src/embed/sweeper.ts";
import { _setTestGetProfiles } from "../src/queries/profileStore.ts";

process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:14318";

const SPACE = "did:web:trace-smoke.example";
const USER = UserDid.assert("did:plc:trace-smoke-user");
const CHANNEL = newUlid();

_resetEmbedSweeper();

const db = openDb({ path: ":memory:" });
const space = db.forSpace!(SPACE);
await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
await space.run("insert into comp_space (entity) values (?)", [SPACE]);
await space.run("insert into comp_info (entity, name) values (?, ?)", [SPACE, "Trace Smoke Space"]);
await space.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);
await space.run("insert into comp_user (did) values (?)", [USER]);
await space.run("insert into edges (head, tail, label) values (?, ?, 'member')", [SPACE, USER]);
await space.run("insert into edges (head, tail, label) values (?, ?, 'member')", [USER, SPACE]);
await space.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [SPACE, USER]);
await space.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
await space.run(
  "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
  [CHANNEL],
);

// getMessages resolves its per-space DB via the GLOBAL entity→space index
// (`openSpaceDbForEntity`), so the channel must be registered there too.
await openGlobalDb().run(
  "insert into entity_space (entity_id, space_did) values (?, ?)",
  [CHANNEL, SPACE],
);

_setTestGetProfiles(async () => []);
const handle = await createAppserver({
  port: 0,
  authVerifier: testAuthVerifier,
  dbPath: ":memory:",
  readStateDbPath: ":memory:",
  quiet: true,
  disableBackgroundWorkers: true,
});

const base = `http://localhost:${handle.port}`;
const authed: RequestInit = {
  headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
};

const threads = await fetch(
  `${base}/xrpc/space.roomy.space.getThreads?spaceId=${encodeURIComponent(SPACE)}`,
  authed,
);
console.log("getThreads   →", threads.status);

const messages = await fetch(
  `${base}/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(CHANNEL)}`,
  authed,
);
console.log("getMessages  →", messages.status);

const send = await fetch(`${base}/xrpc/space.roomy.space.sendEvents`, {
  method: "POST",
  headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
  body: JSON.stringify({
    spaceId: SPACE,
    events: [
      {
        id: newUlid(),
        $type: "space.roomy.message.createMessage.v0",
        room: CHANNEL,
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("hello from trace smoke").toString("base64") },
        },
        extensions: {},
      },
    ],
  }),
});
console.log("sendEvents   →", send.status, await send.text());

// Drains the batch span processor so the spans actually leave the process.
await handle.close();
closeDb();
console.log("SMOKE_DONE");
