/**
 * Generate atproto lexicon JSON from arktype schemas.
 *
 * Per Slice 9 of docs/plans/.llm.2026-05-17-sdk-thin-client-extraction.md,
 * these lexicons exist for THIRD-PARTY clients of the appserver (standard
 * atproto agents that consume registered lexicons). Our own SDK does not
 * import them at runtime — it validates via arktype directly.
 *
 * The generator walks `src/schemas/queries/*.ts` and `src/schemas/procedures/*.ts`,
 * dynamically imports each module to read its `NSID`, `Params`/`Input`,
 * and `Response`/`Output` arktype Types, converts each to a JSON Schema via
 * `Type.toJsonSchema()`, then maps the JSON Schema subset we support to
 * an atproto lexicon definition.
 *
 * # Supported arktype subset
 *
 * Each field's JSON Schema must reduce to one of:
 *   - `{ type: "string" }`                        → lex string
 *   - `{ type: "string", enum: [...] }`           → lex string with knownValues
 *   - `{ type: "number" }`, `{ type: "integer" }` → lex integer
 *   - `{ type: "boolean" }`                       → lex boolean
 *   - `{ type: "array", items: <recursive> }`     → lex array
 *   - `{ type: "object", properties, required }`  → lex object (nested)
 *   - `{ anyOf: [<T>, { type: "null" }] }`        → <T>, omitted from `required`
 *
 * Anything else (intersections, refs, complex unions, regex constraints) is
 * UNSUPPORTED — the generator throws with the offending NSID + field path.
 *
 * # Output
 *
 * One file per NSID, written to `src/schemas/lexicons/<nsid>.json`. The
 * directory is wiped before each run so deleted schemas don't leave
 * dangling lexicons.
 */

import { readdir, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const SCHEMAS_DIR = join(SDK_ROOT, "src/schemas");
const QUERIES_DIR = join(SCHEMAS_DIR, "queries");
const PROCEDURES_DIR = join(SCHEMAS_DIR, "procedures");
const LEXICONS_DIR = join(SCHEMAS_DIR, "lexicons");

type LexProp =
  | { type: "string"; knownValues?: string[] }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "array"; items: LexProp }
  | { type: "object"; required?: string[]; properties: Record<string, LexProp> };

interface ArkLike {
  toJsonSchema?: () => unknown;
}

function isArkType(v: unknown): v is ArkLike {
  // arktype Type is a callable function with extra methods attached.
  return (
    (typeof v === "function" || (typeof v === "object" && v !== null)) &&
    typeof (v as ArkLike).toJsonSchema === "function"
  );
}

function jsonSchemaToLex(
  schema: unknown,
  nsid: string,
  path: string,
): LexProp {
  if (typeof schema !== "object" || schema === null) {
    throw new Error(
      `${nsid}: ${path} → not an object JSON Schema: ${JSON.stringify(schema)}`,
    );
  }
  const s = schema as Record<string, unknown>;

  // Nullable union: anyOf containing a `{ type: "null" }` branch.
  if (Array.isArray(s["anyOf"])) {
    const branches = s["anyOf"] as Array<Record<string, unknown>>;
    const nonNull = branches.filter((b) => b["type"] !== "null");
    if (nonNull.length === 1 && branches.length === 2) {
      // Caller should drop this field from `required` to express the
      // nullable nature; the lex prop itself is just the non-null branch.
      return jsonSchemaToLex(nonNull[0], nsid, `${path}|nullable`);
    }
    throw new Error(
      `${nsid}: ${path} → unsupported anyOf (only T|null is supported), got ${JSON.stringify(
        s["anyOf"],
      )}`,
    );
  }

  const t = s["type"];
  if (t === "string") {
    if (Array.isArray(s["enum"])) {
      return {
        type: "string",
        knownValues: s["enum"].map((v) => String(v)),
      };
    }
    return { type: "string" };
  }
  if (t === "number" || t === "integer") return { type: "integer" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "array") {
    return {
      type: "array",
      items: jsonSchemaToLex(s["items"], nsid, `${path}[]`),
    };
  }
  if (t === "object") {
    const props = (s["properties"] ?? {}) as Record<string, unknown>;
    const required = Array.isArray(s["required"])
      ? (s["required"] as string[])
      : [];
    const out: Record<string, LexProp> = {};
    const outRequired: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      const lex = jsonSchemaToLex(v, nsid, `${path}.${k}`);
      out[k] = lex;
      // Drop nullable fields from `required` even if the original schema
      // listed them, since lex props express nullability via absence-from-required.
      const isNullable =
        typeof v === "object" &&
        v !== null &&
        Array.isArray((v as Record<string, unknown>)["anyOf"]) &&
        ((v as Record<string, unknown>)["anyOf"] as Array<Record<string, unknown>>).some(
          (b) => b["type"] === "null",
        );
      if (required.includes(k) && !isNullable) outRequired.push(k);
    }
    return {
      type: "object",
      ...(outRequired.length > 0 ? { required: outRequired } : {}),
      properties: out,
    };
  }
  throw new Error(`${nsid}: ${path} → unsupported JSON Schema type: ${String(t)}`);
}

/** Lex `parameters` only accepts a flat scalar-property `params` def. */
function lexParameters(arkType: ArkLike, nsid: string): unknown {
  const js = arkType.toJsonSchema!() as Record<string, unknown>;
  if (js["type"] !== "object") {
    throw new Error(`${nsid}: query params must be an object schema`);
  }
  const props = (js["properties"] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(js["required"])
    ? (js["required"] as string[])
    : [];

  // Empty params → omit the `parameters` block entirely.
  if (Object.keys(props).length === 0) return undefined;

  const outProps: Record<string, unknown> = {};
  const outRequired: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const lex = jsonSchemaToLex(v, nsid, `params.${k}`);
    if (
      lex.type !== "string" &&
      lex.type !== "integer" &&
      lex.type !== "boolean"
    ) {
      throw new Error(
        `${nsid}: params.${k} must be scalar (string|integer|boolean) for atproto lex; got ${lex.type}`,
      );
    }
    outProps[k] = lex;
    if (required.includes(k)) outRequired.push(k);
  }
  return {
    type: "params",
    ...(outRequired.length > 0 ? { required: outRequired } : {}),
    properties: outProps,
  };
}

function lexBodySchema(arkType: ArkLike, nsid: string, kind: string): unknown {
  const js = arkType.toJsonSchema!() as Record<string, unknown>;
  return jsonSchemaToLex(js, nsid, kind);
}

interface ProcedureModule {
  NSID: string;
  Input?: ArkLike;
  Output?: ArkLike;
}

interface QueryModule {
  NSID: string;
  Params?: ArkLike;
  Response?: ArkLike;
}

async function generateForFile(
  filePath: string,
  kind: "query" | "procedure",
): Promise<{ nsid: string; lexicon: unknown } | null> {
  const url = pathToFileURL(filePath).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const nsid = mod["NSID"];
  if (typeof nsid !== "string") {
    // Skip files without an NSID export (e.g. _message.ts internals).
    return null;
  }

  if (kind === "query") {
    const q = mod as unknown as QueryModule;
    const defs: Record<string, unknown> = { type: "query" };
    if (q.Params && isArkType(q.Params)) {
      const params = lexParameters(q.Params, nsid);
      if (params) defs["parameters"] = params;
    }
    if (q.Response && isArkType(q.Response)) {
      defs["output"] = {
        encoding: "application/json",
        schema: lexBodySchema(q.Response, nsid, "output"),
      };
    }
    return { nsid, lexicon: { lexicon: 1, id: nsid, defs: { main: defs } } };
  }

  const p = mod as unknown as ProcedureModule;
  const defs: Record<string, unknown> = { type: "procedure" };
  if (p.Input && isArkType(p.Input)) {
    // Empty arktype object schemas have no properties → skip `input` block.
    const js = p.Input.toJsonSchema!() as Record<string, unknown>;
    const props = (js["properties"] ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length > 0) {
      defs["input"] = {
        encoding: "application/json",
        schema: lexBodySchema(p.Input, nsid, "input"),
      };
    }
  }
  if (p.Output && isArkType(p.Output)) {
    const js = p.Output.toJsonSchema!() as Record<string, unknown>;
    const props = (js["properties"] ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length > 0) {
      defs["output"] = {
        encoding: "application/json",
        schema: lexBodySchema(p.Output, nsid, "output"),
      };
    }
  }
  return { nsid, lexicon: { lexicon: 1, id: nsid, defs: { main: defs } } };
}

async function listSchemaFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "index.ts")
    .map((f) => join(dir, f));
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");

  const queryFiles = await listSchemaFiles(QUERIES_DIR);
  const procFiles = await listSchemaFiles(PROCEDURES_DIR);

  const generated = new Map<string, unknown>();
  for (const f of queryFiles) {
    const r = await generateForFile(f, "query");
    if (r) generated.set(r.nsid, r.lexicon);
  }
  for (const f of procFiles) {
    const r = await generateForFile(f, "procedure");
    if (r) generated.set(r.nsid, r.lexicon);
  }

  if (checkOnly) {
    if (!existsSync(LEXICONS_DIR)) {
      throw new Error(
        `lexicons directory missing at ${LEXICONS_DIR}; run \`pnpm generate:lexicons\``,
      );
    }
    let diffs = 0;
    for (const [nsid, lex] of generated) {
      const path = join(LEXICONS_DIR, `${nsid}.json`);
      if (!existsSync(path)) {
        console.error(`STALE: ${nsid}.json missing`);
        diffs++;
        continue;
      }
      const onDisk = await readFile(path, "utf8");
      const fresh = JSON.stringify(lex, null, 2) + "\n";
      if (onDisk !== fresh) {
        console.error(`STALE: ${nsid}.json differs from regenerated output`);
        diffs++;
      }
    }
    if (diffs > 0) {
      console.error(
        `\n${diffs} lexicon(s) stale. Run \`pnpm generate:lexicons\` and commit.`,
      );
      process.exit(1);
    }
    console.log(`✓ All ${generated.size} lexicon(s) match generator output.`);
    return;
  }

  // Wipe + regenerate.
  await rm(LEXICONS_DIR, { recursive: true, force: true });
  await mkdir(LEXICONS_DIR, { recursive: true });
  for (const [nsid, lex] of generated) {
    const path = join(LEXICONS_DIR, `${nsid}.json`);
    await writeFile(path, JSON.stringify(lex, null, 2) + "\n");
  }
  console.log(`Generated ${generated.size} lexicon(s) in ${LEXICONS_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
