/**
 * ITF (Informal Trace Format) JSON decoder for Quint MBT traces.
 *
 * Quint emits traces in Apalache's ITF format with these encodings:
 *   {"#set":[...]}                  → Set
 *   {"#map":[[k, v], ...]}          → Map (entries; key may itself be encoded)
 *   {"#tup":[...]}                  → tuple
 *   {"#bigint":"123"}               → bigint
 *   {"tag":"X", "value":<payload>}  → sum-type variant (nullary uses #tup:[])
 *   plain object                    → record
 *   string | number | boolean       → as-is
 *
 * Top-level file shape (per `quint run --mbt --out-itf`):
 *   { "#meta": ..., "vars": [...], "states": [{ "#meta":{"index":n}, <var>:<value>, ... }, ...] }
 */

export type Variant<T extends string = string, V = unknown> = {
  tag: T;
  value: V;
};

export type Decoded =
  | string
  | number
  | bigint
  | boolean
  | Decoded[]
  | Set<Decoded>
  | Variant<string, Decoded>
  | { [key: string]: Decoded };

/** Map entries with possibly non-string keys. Tuple-keyed maps stay as pairs. */
export type DecodedMap<K = Decoded, V = Decoded> = [K, V][];

export interface ItfTrace<S = Record<string, Decoded>> {
  meta: { format: string; source: string; status: string; description?: string };
  vars: string[];
  states: ItfState<S>[];
}

export interface ItfState<S> {
  index: number;
  actionTaken: string;
  nondetPicks: Record<string, Decoded>;
  vars: S;
}

export function decode(json: unknown): Decoded {
  if (json === null || typeof json !== "object") {
    return json as Decoded;
  }
  if (Array.isArray(json)) {
    return (json as unknown[]).map(decode);
  }
  const obj = json as Record<string, unknown>;

  if ("#set" in obj) {
    return new Set((obj["#set"] as unknown[]).map(decode));
  }
  if ("#map" in obj) {
    return (obj["#map"] as [unknown, unknown][]).map(
      ([k, v]) => [decode(k), decode(v)] as [Decoded, Decoded],
    ) as unknown as Decoded;
  }
  if ("#tup" in obj) {
    return (obj["#tup"] as unknown[]).map(decode);
  }
  if ("#bigint" in obj) {
    return BigInt(obj["#bigint"] as string);
  }
  // Variant: exactly the keys {tag, value}.
  const keys = Object.keys(obj);
  if (
    keys.length === 2 &&
    keys.includes("tag") &&
    keys.includes("value") &&
    typeof obj.tag === "string"
  ) {
    return { tag: obj.tag, value: decode(obj.value) };
  }

  // Plain record.
  const out: { [key: string]: Decoded } = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = decode(v);
  }
  return out;
}

/**
 * Parse an ITF trace file. Splits each state into the MBT metadata fields
 * (`actionTaken`, `nondetPicks`) and the user-defined state vars (`vars`).
 *
 * `S` is the shape of the decoded user-defined vars — pass a typed shape
 * (e.g. `SpecVars`) to get autocomplete in the harness.
 */
export function parseTrace<S = Record<string, Decoded>>(
  json: unknown,
): ItfTrace<S> {
  if (typeof json !== "object" || json === null || !("states" in json)) {
    throw new Error("not an ITF trace: missing #meta/states");
  }
  const root = json as Record<string, unknown>;
  const meta = (root["#meta"] ?? {}) as ItfTrace["meta"];
  const vars = (root.vars ?? []) as string[];
  const rawStates = (root.states ?? []) as Record<string, unknown>[];

  const states: ItfState<S>[] = rawStates.map((raw) => {
    const stateMeta = (raw["#meta"] ?? {}) as { index?: number };
    const actionTaken = (raw["mbt::actionTaken"] ?? "") as string;
    const rawPicks = (raw["mbt::nondetPicks"] ?? {}) as Record<string, unknown>;
    const nondetPicks: Record<string, Decoded> = {};
    for (const [k, v] of Object.entries(rawPicks)) {
      nondetPicks[k] = decode(v);
    }

    const decodedVars: Record<string, Decoded> = {};
    for (const k of Object.keys(raw)) {
      if (k === "#meta" || k === "mbt::actionTaken" || k === "mbt::nondetPicks") {
        continue;
      }
      decodedVars[k] = decode(raw[k]);
    }

    return {
      index: stateMeta.index ?? 0,
      actionTaken,
      nondetPicks,
      vars: decodedVars as S,
    };
  });

  return { meta, vars, states };
}

// ── Helpers for working with decoded values ────────────────────────────

export function asSet<T>(v: Decoded): Set<T> {
  if (!(v instanceof Set)) {
    throw new Error(`expected Set, got ${describe(v)}`);
  }
  return v as Set<T>;
}

export function asMap<K = Decoded, V = Decoded>(v: Decoded): DecodedMap<K, V> {
  if (!Array.isArray(v) || (v.length > 0 && !Array.isArray(v[0]))) {
    throw new Error(`expected Map (entries array), got ${describe(v)}`);
  }
  return v as unknown as DecodedMap<K, V>;
}

export function asVariant<T extends string = string, V = Decoded>(
  v: Decoded,
): Variant<T, V> {
  if (
    typeof v !== "object" ||
    v === null ||
    Array.isArray(v) ||
    v instanceof Set ||
    !("tag" in (v as object)) ||
    !("value" in (v as object))
  ) {
    throw new Error(`expected Variant, got ${describe(v)}`);
  }
  return v as Variant<T, V>;
}

/** Look up a value in a tuple-keyed map by deep-equal on the key array. */
export function mapLookup<K extends Decoded[], V>(
  map: DecodedMap<K, V>,
  key: K,
): V | undefined {
  for (const [k, v] of map) {
    if (arrayEqual(k as Decoded[], key)) return v;
  }
  return undefined;
}

function arrayEqual(a: Decoded[], b: Decoded[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v instanceof Set) return `Set(${v.size})`;
  return typeof v;
}
