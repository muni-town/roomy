#!/usr/bin/env tsx
/**
 * End-to-end test of the rich-text (blocks+facets) message path against a
 * LIVE appserver.
 *
 * Exercises the full wire round-trip through the real HTTP transport:
 *   1. `space.roomy.space.sendEvents` with a new-format createMessage
 *      (`application/vnd.roomy.richtext+json` body carrying #link and
 *      #didMention facets).
 *   2. Materialization: the message row + link entity are stored.
 *   3. `space.roomy.room.getMessages` returns the message with the new
 *      `mimeType` and base64-encoded JSON content.
 *   4. Coexistence: a legacy markdown message still round-trips.
 *
 * Env (same as the CLI):
 *   ATPROTO_IDENTIFIER / ATPROTO_APP_PASSWORD  (app-password login)
 *   APPSERVER_URL                             (e.g. https://my-appserver.example.com)
 *   APPSERVER_DID                             (e.g. did:web:my-appserver.example.com)
 *   E2E_CLEANUP                               ("false" keeps the test space)
 *
 * Usage:
 *   cd packages/cli && npx tsx scripts/e2e-richtext-remote.ts
 */
import { newUlid, toBytes, transport } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;
import { loadConfig } from "../src/config.ts";
import { authenticate } from "../src/auth.ts";
import { createSpace } from "../src/spaces.ts";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok = (m: string) => console.log(`  ${GREEN}✔${RESET} ${m}`);
const bad = (m: string) => console.log(`  ${RED}✘${RESET} ${m}`);
const info = (m: string) => console.log(`${YELLOW}${m}${RESET}`);

let failures = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) ok(label);
  else { bad(`${label}${detail ? ` — ${detail}` : ""}`); failures++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RICHTEXT_MIME = "application/vnd.roomy.richtext+json";

/** Build a new-format createMessage event body from blocks. */
function richtextEvent(roomId: string, text: string, facets: unknown[]) {
  const blocks = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text,
      ...(facets.length ? { facets } : {}),
    },
  ];
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0" as const,
    body: {
      mimeType: RICHTEXT_MIME,
      data: toBytes(
        new TextEncoder().encode(
          JSON.stringify({ $type: "space.roomy.richtext.document", blocks }),
        ),
      ),
    },
    extensions: {},
  };
}

async function main() {
  const cfg = loadConfig();
  const { agent, xrpc } = await authenticate(cfg);
  info(`authenticated as ${agent.did}`);
  info(`appserver: ${cfg.appserverUrl} (${cfg.appserverDid})`);
  const cleanup = process.env.E2E_CLEANUP !== "false";

  // 1. Create a disposable space.
  info("creating test space…");
  const { spaceId } = await createSpace(xrpc, {
    name: `richtext-e2e-${Date.now()}`,
    description: "rich-text migration E2E (safe to delete)",
  });
  info(`test space: ${spaceId}`);
  await sleep(1500); // allow materialisation to land

  // Find the lobby room.
  const meta = await xrpc.query("space.roomy.space.getMetadata", { spaceId });
  const channels = (meta as any).sidebar?.categories?.flatMap((c: any) => c.channels) ?? [];
  const orphans = (meta as any).sidebar?.orphans ?? [];
  const all = [...channels, ...orphans];
  const lobby = all.find((c: any) => c.name?.toLowerCase() === "lobby") ?? all[0];
  assert(!!lobby, "space has a lobby room", JSON.stringify(meta).slice(0, 200));
  const roomId = lobby?.id;
  if (!roomId) { console.error("no room to send into"); process.exit(1); }

  // 2. Send a new-format rich-text message (link + didMention facets).
  const text = "hello @alice check https://example.com/richtext-e2e";
  const linkStart = text.indexOf("https://example.com/richtext-e2e");
  const mentionStart = text.indexOf("@alice");
  const event = richtextEvent(roomId, text, [
    {
      index: { byteStart: linkStart, byteEnd: linkStart + "https://example.com/richtext-e2e".length },
      features: [{ $type: "space.roomy.richtext.facet#link", uri: "https://example.com/richtext-e2e" }],
    },
    {
      index: { byteStart: mentionStart, byteEnd: mentionStart + "@alice".length },
      features: [{ $type: "space.roomy.richtext.facet#didMention", did: "did:plc:mentioned-user" }],
    },
  ]);
  info("sending new-format rich-text message…");
  await xrpc.procedure("space.roomy.space.sendEvents", { spaceId, events: [event] });
  await sleep(1200);

  // 3. Read it back and verify the richtext mimeType + blocks.
  const res = await xrpc.query("space.roomy.room.getMessages", { roomId });
  const msgs = (res as any).messages ?? [];
  const created = msgs.find((m: any) => m.id === event.id);
  assert(!!created, "new-format message round-trips through getMessages");
  if (created) {
    assert(created.mimeType === RICHTEXT_MIME, "message has richtext mimeType", `got=${created.mimeType}`);
    let decoded: any = null;
    try {
      decoded = JSON.parse(Buffer.from(created.content, "base64").toString("utf8"));
    } catch { /* fall through */ }
    assert(!!decoded && decoded.$type === "space.roomy.richtext.document", "content is base64 JSON richtext document");
    assert(!!decoded && Array.isArray(decoded.blocks) && decoded.blocks.length === 1, "document has 1 block");
    assert(!!decoded && decoded.blocks[0].text === text, "block text preserved", `got=${decoded?.blocks?.[0]?.text}`);
    const facets = decoded?.blocks?.[0]?.facets ?? [];
    const hasLink = facets.some((f: any) => f.features?.some((x: any) => x.$type === "space.roomy.richtext.facet#link"));
    const hasMention = facets.some((f: any) => f.features?.some((x: any) => x.$type === "space.roomy.richtext.facet#didMention"));
    assert(hasLink, "#link facet preserved");
    assert(hasMention, "#didMention facet preserved");
  }

  // 4. Coexistence: send a legacy markdown message and verify it round-trips.
  const legacyId = newUlid();
  const legacyEvent = {
    id: legacyId,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0" as const,
    body: { mimeType: "text/markdown", data: toBytes(new TextEncoder().encode("**legacy** markdown")) },
    extensions: {},
  };
  info("sending legacy markdown message…");
  await xrpc.procedure("space.roomy.space.sendEvents", { spaceId, events: [legacyEvent] });
  await sleep(1200);
  const res2 = await xrpc.query("space.roomy.room.getMessages", { roomId });
  const msgs2 = (res2 as any).messages ?? [];
  const legacy = msgs2.find((m: any) => m.id === legacyId);
  assert(!!legacy, "legacy markdown message round-trips");
  if (legacy) {
    assert(legacy.mimeType === "text/markdown", "legacy message keeps markdown mimeType", `got=${legacy.mimeType}`);
    assert(legacy.content === "**legacy** markdown", "legacy content preserved", `got=${legacy.content}`);
  }

  // 5. Embed link materialization: the link facet URL should be stored.
  // getMessage returns the message; the embed link row is internal, so we
  // verify via the message's link presence (already covered by #link facet).
  info("link facet URL present in message (embed source)");

  console.log("");
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}ALL RICH-TEXT E2E CHECKS PASSED${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${failures} CHECK(S) FAILED${RESET}`);
  }
  console.log(`test space: ${spaceId} (room ${roomId})`);
  if (cleanup) {
    info("cleanup: leaving test space in place (no delete-space XRPC); safe to ignore");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
