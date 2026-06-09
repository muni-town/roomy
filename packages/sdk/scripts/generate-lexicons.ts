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
 * # Atproto lexicon constraints
 *
 * The atproto lexicon format is restrictive about type composition:
 *   - `parameters` properties must be scalars (string, integer, boolean).
 *   - Body `schema` may be an inline object at the top level, OR a ref.
 *   - Object-typed properties and array items must use `{ type: "ref", ref: "#defName" }`.
 *   - Each named object def lives in the lexicon's `defs` alongside `main`.
 *   - Nullable fields (string | null) are expressed by omitting them from `required`
 *     and adding them to the parent object's `nullable` array.
 *   - `params` does not support `nullable` — nullable params fields are simply
 *     omitted from `required`.
 *
 * # Supported arktype subset
 *
 * Each field's JSON Schema must reduce to one of:
 *   - `{ type: "string" }`                        → lex string
 *   - `{ type: "string", enum: [...] }`           → lex string with knownValues
 *   - `{ enum: [...] }` (no type)                 → lex string with knownValues (string literal union)
 *   - `{ type: "number" }`, `{ type: "integer" }` → lex integer
 *   - `{ type: "boolean" }`                       → lex boolean
 *   - `{ type: "array", items: <recursive> }`     → lex array
 *   - `{ type: "object", properties, required }`  → extracted to a named def, referenced
 *   - `{ anyOf: [<T>, { type: "null" }] }`        → <T>, omitted from `required`
 *
 * Anything else (intersections, complex unions, regex constraints) is
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
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isValidLexiconDoc } from "@atproto/lexicon";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const SCHEMAS_DIR = join(SDK_ROOT, "src/schemas");
const QUERIES_DIR = join(SCHEMAS_DIR, "queries");
const PROCEDURES_DIR = join(SCHEMAS_DIR, "procedures");
const LEXICONS_DIR = join(SCHEMAS_DIR, "lexicons");

// ─── Types ────────────────────────────────────────────────────────────────

/** Property-level types valid inside a lexicon object def. */
type LexSlot =
  | { type: "string"; knownValues?: string[] }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "array"; items: LexSlot }
  | { type: "ref"; ref: string };

/** A named object definition to add to `defs`. */
interface LexObjDef {
  type: "object";
  required?: string[];
  /** Property names that may be present with a null value. */
  nullable?: string[];
  properties: Record<string, LexSlot>;
}

/** Accumulator for named defs extracted during schema conversion. */
class DefCollector {
  readonly defs = new Map<string, LexObjDef>();
  readonly #usedNames = new Set<string>();

  constructor(private nsid: string) {}

  /**
   * Register a named def. If the name collides, appends a numeric suffix.
   * Returns the final def name (without the `#` prefix).
   */
  register(baseName: string, def: LexObjDef): string {
    let name = baseName;
    let suffix = 2;
    while (this.#usedNames.has(name)) {
      name = `${baseName}${suffix++}`;
    }
    this.#usedNames.add(name);
    this.defs.set(name, def);
    return name;
  }
}

// ─── Arktype helpers ──────────────────────────────────────────────────────

interface ArkLike {
  toJsonSchema?: () => unknown;
}

function isArkType(v: unknown): v is ArkLike {
  return (
    (typeof v === "function" || (typeof v === "object" && v !== null)) &&
    typeof (v as ArkLike).toJsonSchema === "function"
  );
}

// ─── JSON Schema → Lexicon conversion ─────────────────────────────────────

/**
 * Convert a JSON Schema node into a "slot" (property value or array item).
 * Object types are extracted into named defs and returned as refs.
 */
function convertSlot(
  schema: unknown,
  nsid: string,
  path: string,
  collector: DefCollector,
): LexSlot {
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
      return convertSlot(nonNull[0], nsid, `${path}|nullable`, collector);
    }
    throw new Error(
      `${nsid}: ${path} → unsupported anyOf (only T|null is supported), got ${JSON.stringify(s["anyOf"])}`,
    );
  }

  // String literal unions ('read' | 'readwrite') emit { enum: [...] } without a
  // `type` field. Treat as string with knownValues.
  if (!("type" in s) && Array.isArray(s["enum"])) {
    const vals = s["enum"].map((v: unknown) => String(v));
    if (vals.length === 0) {
      throw new Error(`${nsid}: ${path} → empty enum`);
    }
    return { type: "string", knownValues: vals };
  }

  // Single string literal (e.g. `'message'` → { const: "message" }).
  if ("const" in s && typeof s["const"] === "string") {
    return { type: "string", knownValues: [s["const"]] };
  }

  // Single number literal const.
  if ("const" in s && typeof s["const"] === "number") {
    return { type: "integer" };
  }

  const t = s["type"];
  if (t === "string") {
    if (Array.isArray(s["enum"])) {
      return {
        type: "string",
        knownValues: (s["enum"] as unknown[]).map((v) => String(v)),
      };
    }
    return { type: "string" };
  }
  if (t === "number" || t === "integer") return { type: "integer" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "array") {
    return {
      type: "array",
      items: convertSlot(s["items"], nsid, `${path}[]`, collector),
    };
  }
  if (t === "object") {
    // Extract to a named def and return a ref.
    const def = convertObjectDef(schema, nsid, path, collector);
    // Derive def name from the path: use the last segment, cleaned of
    // array/nullable suffixes (e.g. "output.messages[]" → "message",
    // "output.messages[].forwardedFrom|nullable" → "forwardedFrom").
    const raw = path.split(".").pop() || "obj";
    // Strip array/nullable suffixes but keep the original property name
    // (e.g. "output.messages[]" → "messages", not "message").
    const baseName = raw.replace(/\[\]$/, "").replace(/\|nullable$/, "");
    const defName = collector.register(baseName, def);
    return { type: "ref", ref: `#${defName}` };
  }
  throw new Error(
    `${nsid}: ${path} → unsupported JSON Schema type: ${String(t)}`,
  );
}

/**
 * Convert a JSON Schema object into a lexicon object def.
 * All property values are converted via `convertSlot` (which extracts
 * nested objects to refs).
 */
function convertObjectDef(
  schema: unknown,
  nsid: string,
  path: string,
  collector: DefCollector,
): LexObjDef {
  const s = schema as Record<string, unknown>;
  const props = (s["properties"] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(s["required"])
    ? (s["required"] as string[])
    : [];

  const outProps: Record<string, LexSlot> = {};
  const outRequired: string[] = [];
  const outNullable: string[] = [];

  for (const [k, v] of Object.entries(props)) {
    const slot = convertSlot(v, nsid, `${path}.${k}`, collector);
    outProps[k] = slot;

    const isNullable = isNullableSchema(v);
    if (required.includes(k) && !isNullable) outRequired.push(k);
    if (isNullable) outNullable.push(k);
  }

  return {
    type: "object",
    ...(outRequired.length > 0 ? { required: outRequired } : {}),
    ...(outNullable.length > 0 ? { nullable: outNullable } : {}),
    properties: outProps,
  };
}

/** Check if a JSON Schema node represents a nullable type. */
function isNullableSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const s = schema as Record<string, unknown>;
  if (!Array.isArray(s["anyOf"])) return false;
  return (s["anyOf"] as Array<Record<string, unknown>>).some(
    (b) => b["type"] === "null",
  );
}

// ─── Parameters (flat scalars only) ───────────────────────────────────────

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
    // Params must be scalars; use a minimal conversion without def extraction.
    const lex = scalarOnlyLex(v, nsid, `params.${k}`);
    outProps[k] = lex;
    if (required.includes(k) && !isNullableSchema(v)) outRequired.push(k);
  }
  return {
    type: "params",
    ...(outRequired.length > 0 ? { required: outRequired } : {}),
    properties: outProps,
  };
}

/** Convert a JSON Schema to a scalar-only lexicon prop (for parameters). */
function scalarOnlyLex(
  schema: unknown,
  nsid: string,
  path: string,
): LexSlot {
  if (typeof schema !== "object" || schema === null) {
    throw new Error(
      `${nsid}: ${path} → not an object JSON Schema: ${JSON.stringify(schema)}`,
    );
  }
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s["anyOf"])) {
    const branches = s["anyOf"] as Array<Record<string, unknown>>;
    const nonNull = branches.filter((b) => b["type"] !== "null");
    if (nonNull.length === 1 && branches.length === 2) {
      return scalarOnlyLex(nonNull[0], nsid, `${path}|nullable`);
    }
    throw new Error(`${nsid}: ${path} → unsupported anyOf in params`);
  }

  if (!("type" in s) && Array.isArray(s["enum"])) {
    return {
      type: "string",
      knownValues: (s["enum"] as unknown[]).map((v) => String(v)),
    };
  }

  // Single string literal const.
  if ("const" in s && typeof s["const"] === "string") {
    return { type: "string", knownValues: [s["const"]] };
  }

  const t = s["type"];
  if (t === "string") {
    if (Array.isArray(s["enum"])) {
      return {
        type: "string",
        knownValues: (s["enum"] as unknown[]).map((v) => String(v)),
      };
    }
    return { type: "string" };
  }
  if (t === "number" || t === "integer") return { type: "integer" };
  if (t === "boolean") return { type: "boolean" };
  throw new Error(
    `${nsid}: ${path} must be scalar (string|integer|boolean) for atproto lex params; got ${String(t)}`,
  );
}

// ─── Body schema (input/output) ───────────────────────────────────────────

/**
 * Convert a body schema into:
 *   - `schema`: the top-level schema value (either an inline object or a ref)
 *   - `defs`: additional named defs to merge into the lexicon's `defs`
 */
function lexBodySchema(
  arkType: ArkLike,
  nsid: string,
  kind: string,
): { schema: unknown; defs: Record<string, LexObjDef> } {
  const js = arkType.toJsonSchema!() as Record<string, unknown>;
  const collector = new DefCollector(nsid);

  // If the top-level is an object, we can inline it in the schema
  // (atproto allows this) — but its properties must use refs for nested objects.
  if (js["type"] === "object") {
    const def = convertObjectDef(js, nsid, kind, collector);
    const additionalDefs: Record<string, LexObjDef> = {};
    for (const [name, d] of collector.defs) {
      additionalDefs[name] = d;
    }
    return { schema: def, defs: additionalDefs };
  }

  throw new Error(
    `${nsid}: ${kind} body schema must be an object, got ${String(js["type"])}`,
  );
}

// ─── Per-file generation ──────────────────────────────────────────────────

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

  const allDefs: Record<string, unknown> = {};

  if (kind === "query") {
    const q = mod as unknown as QueryModule;
    const main: Record<string, unknown> = { type: "query" };
    if (q.Params && isArkType(q.Params)) {
      const params = lexParameters(q.Params, nsid);
      if (params) main["parameters"] = params;
    }
    if (q.Response && isArkType(q.Response)) {
      const { schema, defs } = lexBodySchema(q.Response, nsid, "output");
      main["output"] = { encoding: "application/json", schema };
      Object.assign(allDefs, defs);
    }
    allDefs["main"] = main;
    return { nsid, lexicon: { lexicon: 1, id: nsid, defs: allDefs } };
  }

  const p = mod as unknown as ProcedureModule;
  const main: Record<string, unknown> = { type: "procedure" };
  if (p.Input && isArkType(p.Input)) {
    const js = p.Input.toJsonSchema!() as Record<string, unknown>;
    const props = (js["properties"] ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length > 0) {
      const { schema, defs } = lexBodySchema(p.Input, nsid, "input");
      main["input"] = { encoding: "application/json", schema };
      Object.assign(allDefs, defs);
    }
  }
  if (p.Output && isArkType(p.Output)) {
    const js = p.Output.toJsonSchema!() as Record<string, unknown>;
    const props = (js["properties"] ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length > 0) {
      const { schema, defs } = lexBodySchema(p.Output, nsid, "output");
      main["output"] = { encoding: "application/json", schema };
      Object.assign(allDefs, defs);
    }
  }
  allDefs["main"] = main;
  return { nsid, lexicon: { lexicon: 1, id: nsid, defs: allDefs } };
}

// ─── Main ─────────────────────────────────────────────────────────────────

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

    // Also validate against atproto's lexicon schema.
    let validationErrors = 0;
    for (const [nsid] of generated) {
      const path = join(LEXICONS_DIR, `${nsid}.json`);
      const json = JSON.parse(readFileSync(path, "utf8"));
      if (!isValidLexiconDoc(json)) {
        console.error(`INVALID: ${nsid} failed atproto lexicon validation`);
        validationErrors++;
      }
    }
    if (validationErrors > 0) {
      console.error(
        `\n${validationErrors} lexicon(s) failed atproto validation.`,
      );
      process.exit(1);
    }
    console.log(
      `✓ All ${generated.size} lexicon(s) pass atproto lexicon validation.`,
    );
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
