/**
 * Tests for the lexicon publish script.
 *
 * `resolveAuthority` is the part that fails silently: the handle system's
 * `_atproto` record and the lexicon system's `_lexicon` record are different
 * names with different meanings, and querying the wrong one returns nothing —
 * which the script reports as "no authority", exactly as it would for a
 * namespace that is genuinely unconfigured. So the live zone is pinned for an
 * authority that exists, and the "no authority" cases resolve against a zone
 * supplied by the test.
 *
 * Rule for adding a case here: a negative must be non-existent *by
 * construction*. Never assert on a name the project is still publishing
 * records for — today's `undefined` is the next record's red build.
 *
 * The write path runs against a fake repo: the three XRPC calls the script
 * makes. That pins the request shape (`validate: false`, rkey = NSID, the
 * collection) and the read-back comparison that keeps the script from
 * reporting a publish that landed a different document.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { TxtLookup } from "../publish-lexicons.ts";
import { AtpAgent } from "@atproto/api";
import {
  allNsids,
  authorityDomain,
  parseArgs,
  publishLexicon,
  readLexicon,
  recordFor,
  resolveAuthority,
} from "../publish-lexicons.ts";

// ─── Authority ──────────────────────────────────────────────────────────────

describe("authority derivation", () => {
  test("drops the name segment and reverses the rest", () => {
    expect(authorityDomain("space.roomy.user.block")).toBe("user.roomy.space");
    expect(authorityDomain("space.roomy.authComplete")).toBe("roomy.space");
    expect(authorityDomain("edu.university.dept.lab.blogging.getBlogPost")).toBe(
      "blogging.lab.dept.university.edu",
    );
  });

  test("resolves per authority group, without falling back to a parent", async () => {
    // The one published Roomy lexicon; stable, so the live zone is the right
    // source for this positive.
    expect(await resolveAuthority("space.roomy.authComplete")).toBe(
      "did:plc:cyqufxsezk33hqulcilckna6",
    );

    // The negatives resolve against a zone the test owns instead of the live
    // zone. Only the apex `_lexicon.roomy.space` is populated there, so
    // `space.roomy.user.block` has to derive `_lexicon.user.roomy.space` and
    // `space.roomy.richtext.blocks` has to derive
    // `_lexicon.richtext.roomy.space` — both absent by construction, whatever
    // the live zone holds. The parent record is present precisely so the
    // "not hierarchical" claim is load-bearing rather than a lookup that could
    // only have found nothing.
    const apexOnly: TxtLookup = async (name) =>
      name === "_lexicon.roomy.space" ? [["did=did:plc:cyqufxsezk33hqulcilckna6"]] : [];

    expect(await resolveAuthority("space.roomy.user.block", apexOnly)).toBeUndefined();
    expect(await resolveAuthority("space.roomy.richtext.blocks", apexOnly)).toBeUndefined();
  });
});

// ─── Documents ──────────────────────────────────────────────────────────────

describe("lexicon documents", () => {
  test("reads a record lexicon from the directory", () => {
    const doc = readLexicon("space.roomy.user.block");
    expect(doc.id).toBe("space.roomy.user.block");
    expect(doc.lexicon).toBe(1);
    expect((doc.defs.main as { type: string }).type).toBe("record");
  });

  test("refuses an NSID with no file", () => {
    expect(() => readLexicon("space.roomy.not.a.lexicon")).toThrow(/No lexicon file/);
  });

  test("the record is the document plus $type, and nothing else", () => {
    const record = recordFor(readLexicon("space.roomy.user.block"));
    expect(Object.keys(record).sort()).toEqual(["$type", "defs", "id", "lexicon"]);
    expect(record.$type).toBe("com.atproto.lexicon.schema");
    expect(record.id).toBe("space.roomy.user.block");
  });

  test("every lexicon in the directory parses and carries its own id", () => {
    const nsids = allNsids();
    expect(nsids).toContain("space.roomy.user.block");
    expect(nsids).toContain("space.roomy.user.profile");
    // A file with no `main` is still publishable: it is what the lexicons
    // referencing its defs resolve to.
    expect(nsids).toContain("space.roomy.richtext.blocks");
    for (const nsid of nsids) expect(readLexicon(nsid).id).toBe(nsid);
  });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe("arguments", () => {
  test("--all expands to the directory; --dry-run is carried", () => {
    const opts = parseArgs(["--all", "--dry-run"]);
    expect(opts.dryRun).toBe(true);
    expect(opts.nsids).toContain("space.roomy.user.block");
  });

  test("explicit NSIDs pass through; no arguments is an error", () => {
    expect(parseArgs(["space.roomy.user.block"]).nsids).toEqual([
      "space.roomy.user.block",
    ]);
    expect(() => parseArgs([])).toThrow(/Usage/);
  });
});

// ─── Publish round trip ──────────────────────────────────────────────────────

const REPO_DID = "did:plc:cyqufxsezk33hqulcilckna6";
const NSID = "space.roomy.user.block";

describe("publish", () => {
  let server: Server<undefined>;
  let calls: string[];
  let sent: Record<string, unknown> | undefined;
  let sentValidate: boolean | undefined;
  /** What the fake repo returns from `getRecord`; defaults to what was sent. */
  let storedOverride: Record<string, unknown> | undefined;

  beforeEach(() => {
    calls = [];
    sent = undefined;
    sentValidate = undefined;
    storedOverride = undefined;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const method = new URL(req.url).pathname.replace("/xrpc/", "");
        calls.push(method);
        if (method === "com.atproto.server.createSession") {
          return Response.json({
            accessJwt: "a.b.c",
            refreshJwt: "d.e.f",
            handle: "roomy.space",
            did: REPO_DID,
            active: true,
          });
        }
        if (method === "com.atproto.repo.putRecord") {
          const body = (await req.json()) as {
            record: Record<string, unknown>;
            validate?: boolean;
          };
          sent = body.record;
          sentValidate = body.validate;
          return Response.json({
            uri: `at://${REPO_DID}/com.atproto.lexicon.schema/${NSID}`,
            cid: "bafyreic4jrkeswhluqav4whjlvssx23oftjdsom72zmkpy7lyhzwdsemim",
            validationStatus: "unknown",
          });
        }
        if (method === "com.atproto.repo.getRecord") {
          return Response.json({
            uri: `at://${REPO_DID}/com.atproto.lexicon.schema/${NSID}`,
            cid: "bafyreic4jrkeswhluqav4whjlvssx23oftjdsom72zmkpy7lyhzwdsemim",
            value: storedOverride ?? sent,
          });
        }
        return Response.json({ error: "NotFound" }, { status: 404 });
      },
    });
  });

  afterEach(() => server.stop());

  /** An agent logged in against the fake repo, as `main()` leaves it. */
  async function loggedIn(): Promise<AtpAgent> {
    const agent = new AtpAgent({ service: `http://127.0.0.1:${server.port}` });
    await agent.login({ identifier: "roomy.space", password: "x" });
    return agent;
  }

  test("writes the document with validation off and confirms the read-back", async () => {
    const result = await publishLexicon(await loggedIn(), REPO_DID, NSID);

    expect(calls).toEqual([
      "com.atproto.server.createSession",
      "com.atproto.repo.putRecord",
      "com.atproto.repo.getRecord",
    ]);
    // No PDS knows `com.atproto.lexicon.schema` — the language is intentionally
    // not self-describing — so optimistic validation would reject every write.
    expect(sentValidate).toBe(false);
    expect(sent?.$type).toBe("com.atproto.lexicon.schema");
    expect(sent?.id).toBe(NSID);
    expect(result.uri).toBe(`at://${REPO_DID}/com.atproto.lexicon.schema/${NSID}`);
    expect(result.validationStatus).toBe("unknown");
  });

  test("refuses to report success when the repo holds a different document", async () => {
    storedOverride = { $type: "com.atproto.lexicon.schema", id: "other", lexicon: 1, defs: {} };
    await expect(publishLexicon(await loggedIn(), REPO_DID, NSID)).rejects.toThrow(
      /different document/,
    );
  });
});
