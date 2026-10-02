/**
 * Publish lexicons from `lexicons/` as `com.atproto.lexicon.schema` records.
 *
 * A lexicon is published as a record in the repo of its **authority**, which
 * DNS decides: for an NSID, drop the name segment, reverse the rest, and look
 * up `_lexicon.<that domain>`. The lookup is not hierarchical, so
 * `space.roomy.user.block` needs `_lexicon.user.roomy.space` and is unaffected
 * by the `_lexicon.roomy.space` record that governs `space.roomy.authComplete`.
 * One `_lexicon` record serves a whole authority group — every `space.roomy.X.*`
 * NSID — which is why the missing records are few and easy to list.
 *
 * Record collections do not need this: the appserver writes the collection
 * name as a literal and never resolves the NSID. Publishing buys third-party
 * resolution — a client, indexer or validator that does not ship Roomy's
 * source. Permission sets are the exception that *must* resolve, because an
 * authorizing PDS resolves an `include:` scope and fails the session when it
 * cannot.
 *
 * The record is the lexicon document verbatim plus `$type`. It is written with
 * `validate: false`: a PDS validates a record against its *own* copy of the
 * collection's lexicon, and no PDS knows `com.atproto.lexicon.schema` — the
 * lexicon language is intentionally not self-describing — so validation would
 * reject every publish. The write is authenticated as the authority account
 * itself, so a bad record can only be self-inflicted.
 *
 * Usage:
 *   bun run scripts/publish-lexicons.ts <nsid> [<nsid>...] [--dry-run]
 *   bun run scripts/publish-lexicons.ts --all [--dry-run]
 *
 * Environment:
 *   LEXICON_AUTHORITY_IDENTIFIER  handle or DID of the authority account (required)
 *   LEXICON_AUTHORITY_PASSWORD    app password for it (required)
 *   LEXICON_AUTHORITY_PDS         PDS to log in to (default: the authority's DID document)
 *   PLC_DIRECTORY_URL             DID resolver (default: https://plc.directory)
 */

import { readFileSync, existsSync, globSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveTxt } from "node:dns/promises";
import { AtpAgent } from "@atproto/api";
import { IdResolver } from "@atproto/identity";

// ─── Lexicon documents ───────────────────────────────────────────────────

const LEXICONS_DIR = join(import.meta.dir, "..", "lexicons");
const LEXICON_SCHEMA_COLLECTION = "com.atproto.lexicon.schema";

/** A lexicon document as stored on disk. */
export interface LexiconDocument {
  lexicon: number;
  id: string;
  defs: Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
}

/**
 * Read a lexicon from `lexicons/`, rejecting a file whose `id` is not the NSID
 * being published — the record's `id` must equal its rkey, and a mismatch here
 * would land a record that no resolver will ever return.
 */
export function readLexicon(nsid: string): LexiconDocument {
  const path = join(LEXICONS_DIR, `${nsid.split(".").join("/")}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `No lexicon file for ${nsid} (looked in ${relative(process.cwd(), path)})`,
    );
  }
  const doc = JSON.parse(readFileSync(path, "utf8")) as LexiconDocument;
  if (doc.lexicon !== 1) {
    throw new Error(`${nsid}: lexicon version must be 1, got ${doc.lexicon}`);
  }
  if (doc.id !== nsid) {
    throw new Error(`${nsid}: file declares id ${doc.id}; a record's id must match its rkey`);
  }
  if (doc.defs === null || typeof doc.defs !== "object") {
    throw new Error(`${nsid}: missing defs`);
  }
  return doc;
}

/**
 * The record to publish: the document itself, plus `$type`.
 *
 * No `createdAt`, matching the record already published under this collection:
 * the field is not in the meta-schema, and a PDS does not stamp one.
 */
export function recordFor(doc: LexiconDocument): Record<string, unknown> {
  return { $type: LEXICON_SCHEMA_COLLECTION, ...doc };
}

/**
 * Every NSID defined in `lexicons/` — the `--all` set.
 *
 * Everything here is publishable: a query or procedure lexicon describes the
 * HTTP contract just as a record lexicon describes a stored document, and a
 * file with no `main` (a shared `defs` namespace such as
 * `space.roomy.richtext.blocks`) is what the lexicons referencing it resolve
 * to. Files that are not lexicons (`getProfiles.lua`) are skipped by the parse.
 */
export function allNsids(): string[] {
  const ids: string[] = [];
  for (const path of globSync(`${LEXICONS_DIR}/**/*.json`)) {
    const doc = JSON.parse(readFileSync(path, "utf8")) as LexiconDocument;
    if (typeof doc.id !== "string" || typeof doc.lexicon !== "number") {
      throw new Error(`${relative(process.cwd(), path)} is not a lexicon document`);
    }
    ids.push(doc.id);
  }
  return ids.sort();
}

// ─── Authority ───────────────────────────────────────────────────────────

/**
 * The domain whose `_lexicon` TXT record names an NSID's authority: the NSID
 * without its name segment, reversed. `space.roomy.user.block` →
 * `user.roomy.space`.
 */
export function authorityDomain(nsid: string): string {
  const segments = nsid.split(".");
  if (segments.length < 3) throw new Error(`${nsid} is not a valid NSID`);
  return segments.slice(0, -1).reverse().join(".");
}

/** A `_lexicon.<authority>` TXT lookup; the system resolver by default. */
export type TxtLookup = (name: string) => Promise<string[][]>;

/**
 * Resolve the authority DID for an NSID from `_lexicon.<authority>`.
 *
 * Deliberately not `IdResolver.handle.resolve`, which follows the handle
 * system's `_atproto` record — a different prefix with a different meaning,
 * and one that finds nothing under an `_lexicon.*` name.
 *
 * Per the specification more than one `did=` TXT is ambiguous, and absent is
 * absent: both are "no authority", never a fallback to a parent domain.
 *
 * `lookup` is injectable so a caller can resolve against a zone it controls,
 * rather than the live zone this project is still creating records in.
 */
export async function resolveAuthority(
  nsid: string,
  lookup: TxtLookup = resolveTxt,
): Promise<string | undefined> {
  let chunks: string[][];
  try {
    chunks = await lookup(`_lexicon.${authorityDomain(nsid)}`);
  } catch {
    return undefined;
  }
  const dids = chunks
    .map((c) => c.join(""))
    .filter((v) => v.startsWith("did="))
    .map((v) => v.slice("did=".length));
  return dids.length === 1 ? dids[0] : undefined;
}

/** The authority's PDS, from its DID document. */
export async function pdsEndpoint(did: string, idResolver: IdResolver): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  const service = doc?.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  const endpoint =
    typeof service?.serviceEndpoint === "string" ? service.serviceEndpoint : undefined;
  if (!endpoint) {
    throw new Error(
      `${did} has no #atproto_pds service, so it has no repo to publish into; ` +
        `set LEXICON_AUTHORITY_PDS to override`,
    );
  }
  return endpoint;
}

// ─── Publishing ───────────────────────────────────────────────────────────

export interface PublishResult {
  nsid: string;
  uri: string;
  cid: string;
  /** What the PDS said about validation; `valid` when it knew the collection. */
  validationStatus: string | undefined;
}

/**
 * Write one lexicon, then read it back and confirm the repo holds the bytes
 * that were sent. A `putRecord` that landed a different document — a
 * truncation, a proxy rewriting the body — would otherwise be invisible, and
 * this record is what third parties will validate against.
 */
export async function publishLexicon(
  agent: AtpAgent,
  repoDid: string,
  nsid: string,
): Promise<PublishResult> {
  const record = recordFor(readLexicon(nsid));
  const opts = { headers: { "atproto-proxy": `${repoDid}#atproto_pds` } };
  const ref = { repo: repoDid, collection: LEXICON_SCHEMA_COLLECTION, rkey: nsid };

  const written = await agent.com.atproto.repo.putRecord(
    { ...ref, record, validate: false },
    opts,
  );

  const readBack = await agent.com.atproto.repo.getRecord(ref, opts);
  const stored = readBack.data.value as LexiconDocument;
  if (stored.id !== nsid || JSON.stringify(stored) !== JSON.stringify(record)) {
    throw new Error(
      `${nsid}: repo holds a different document than was sent — refusing to report success`,
    );
  }

  return {
    nsid,
    uri: written.data.uri,
    cid: written.data.cid,
    validationStatus: written.data.validationStatus,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

export interface PublishOptions {
  nsids: string[];
  dryRun: boolean;
}

export function parseArgs(argv: string[]): PublishOptions {
  const dryRun = argv.includes("--dry-run");
  if (argv.includes("--all")) return { nsids: allNsids(), dryRun };
  const nsids = argv.filter((a) => !a.startsWith("--"));
  if (nsids.length === 0) {
    throw new Error(
      "Usage: publish-lexicons.ts <nsid> [<nsid>...] [--dry-run], or --all",
    );
  }
  return { nsids, dryRun };
}

/**
 * Group NSIDs by resolved authority, reporting every NSID with no authority at
 * once: creating the TXT records is one trip to the DNS provider regardless of
 * how many NSIDs are waiting on it.
 */
async function resolveTargets(
  nsids: string[],
): Promise<{ groups: Map<string, string[]>; missing: string[] }> {
  const groups = new Map<string, string[]>();
  const missing: string[] = [];
  for (const nsid of nsids) {
    const domain = authorityDomain(nsid);
    const did = await resolveAuthority(nsid);
    if (!did) {
      missing.push(`${nsid}  →  create TXT  _lexicon.${domain}  =  "did=<authority-did>"`);
      continue;
    }
    groups.set(did, [...(groups.get(did) ?? []), nsid]);
    console.log(`${nsid} → ${did}  (_lexicon.${domain})`);
  }
  return { groups, missing };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { groups, missing } = await resolveTargets(opts.nsids);

  if (missing.length > 0) {
    console.error(`\nNo authority for ${missing.length} NSID(s):\n`);
    for (const line of missing) console.error(`  ${line}`);
    console.error(
      `\nThe record must live in that DID's repo, so the TXT record comes first.`,
    );
    process.exit(1);
  }

  if (opts.dryRun) {
    const count = [...groups.values()].reduce((n, v) => n + v.length, 0);
    console.log(
      `\nDry run: ${count} lexicon(s) across ${groups.size} authority group(s) would be published.`,
    );
    return;
  }

  const identifier = process.env.LEXICON_AUTHORITY_IDENTIFIER;
  const password = process.env.LEXICON_AUTHORITY_PASSWORD;
  if (!identifier || !password) {
    throw new Error(
      "Set LEXICON_AUTHORITY_IDENTIFIER and LEXICON_AUTHORITY_PASSWORD to the authority account's credentials",
    );
  }

  const idResolver = new IdResolver({ plcUrl: process.env.PLC_DIRECTORY_URL ?? "https://plc.directory" });
  const pds = process.env.LEXICON_AUTHORITY_PDS;
  const agent = new AtpAgent({
    service:
      pds ?? (await pdsEndpoint([...groups.keys()][0] as string, idResolver)),
  });
  await agent.login({ identifier, password });

  let published = 0;
  for (const [did, nsids] of groups) {
    // The login is the authority account's own; publishing into another repo
    // would either fail or, worse, succeed under the wrong identity.
    if (agent.assertDid !== did) {
      throw new Error(
        `Logged in as ${agent.assertDid}, but ${nsids[0]} is governed by ${did}; ` +
          `publish that group with credentials for ${did}`,
      );
    }
    for (const nsid of nsids) {
      const result = await publishLexicon(agent, did, nsid);
      const validation = result.validationStatus === "valid" ? " (PDS validated)" : "";
      console.log(`  ${result.uri}  cid ${result.cid}${validation}`);
      published++;
    }
  }
  console.log(`\nPublished ${published} lexicon(s).`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
