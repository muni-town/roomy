/// <reference types="node" />

/**
 * Lexicon Generator
 *
 * Converts ArkType schemas to ATProto lexicon JSON.
 *
 * Run with: npx tsx scripts/generate-lexicons.ts
 *
 * This is intentionally lossy - ArkType can express things lexicons can't.
 * The goal is valid, interoperable lexicons, not perfect fidelity.
 */

import { writeFileSync, mkdirSync } from "fs";
import { type, Type } from "arktype";
import { allSchemas, type SchemaEntry } from "../src/lib/schema/registry";

// Output directory for generated lexicons
const OUTPUT_DIR = "./lexicons";

/**
 * Map ArkType's internal representation to lexicon property types.
 *
 * ArkType exposes `.json` for introspection, but the structure varies.
 * We handle the common cases and fall back to 'unknown' for complex types.
 */
function arktypeToLexiconType(t: Type<any>): LexiconType {
  const json = t.json;

  // Handle primitives
  if (json === "string") {
    return { type: "string" };
  }
  if (json === "number") {
    return { type: "integer" }; // Lexicons don't have float, use integer
  }
  if (json === "boolean") {
    return { type: "boolean" };
  }

  // Handle branded/narrowed types by checking the description
  const desc = t.description;
  if (desc === "ulid" || desc === "hash") {
    return { type: "string" }; // Lossy: just string in lexicon
  }
  if (desc === "did") {
    return { type: "string", format: "did" };
  }
  if (desc === "cid") {
    return { type: "cid" };
  }
  if (desc === "timestamp") {
    return { type: "integer" };
  }

  // Handle arrays
  if (typeof json === "object" && json !== null) {
    // Array check - ArkType represents as { "sequence": ... }
    if ("sequence" in json) {
      const itemType = arktypeToLexiconType(t.element as Type<any>);
      return { type: "array", items: itemType };
    }

    // Object check - has "required" or "optional" keys
    if ("required" in json || "optional" in json) {
      return objectToLexicon(t);
    }

    // Union check - has "|" in structure
    if (
      Array.isArray(json) ||
      (typeof json === "string" && json.includes("|"))
    ) {
      return unionToLexicon(t);
    }
  }

  // Handle string literals (for $type discriminators and enums)
  if (typeof json === "string" && json.startsWith("'") && json.endsWith("'")) {
    const value = json.slice(1, -1);
    return { type: "string", const: value };
  }

  // Handle union of string literals (enums)
  if (typeof json === "string" && json.includes("' | '")) {
    const values = json.split(" | ").map((s) => s.replace(/'/g, ""));
    return { type: "string", enum: values };
  }

  // Fallback for complex types
  console.warn(`Unknown ArkType structure, falling back to unknown:`, json);
  return { type: "unknown" };
}

/**
 * Convert an ArkType object type to lexicon object schema
 */
function objectToLexicon(t: Type<any>): LexiconObject {
  const properties: Record<string, LexiconType> = {};
  const required: string[] = [];

  // ArkType exposes props via iteration or internal structure
  // This is a simplified approach - may need refinement based on actual ArkType API
  try {
    const json = t.json;
    if (typeof json === "object" && json !== null) {
      // Try to extract properties from the JSON representation
      const props = (json as any).required || {};
      const optional = (json as any).optional || {};

      for (const [key, value] of Object.entries(props)) {
        properties[key] = arktypeToLexiconType(value as Type<any>);
        required.push(key);
      }

      for (const [key, value] of Object.entries(optional)) {
        properties[key] = arktypeToLexiconType(value as Type<any>);
      }
    }
  } catch (e) {
    console.warn(`Failed to extract object properties:`, e);
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Convert an ArkType union to lexicon union (refs)
 */
function unionToLexicon(t: Type<any>): LexiconUnion {
  // For discriminated unions with $type, we reference other schemas
  // This is complex - for now, return a simple union marker
  return {
    type: "union",
    refs: [], // Would need to extract the $type values and map to schema refs
  };
}

/**
 * Generate a full lexicon document for an event schema
 */
function generateLexicon(nsid: string, entry: SchemaEntry): LexiconDoc {
  const mainDef = arktypeToLexiconType(entry.type);

  return {
    lexicon: 1,
    id: nsid,
    defs: {
      main: {
        type: "object",
        description: entry.description,
        ...(mainDef.type === "object" ? mainDef : { properties: {} }),
      },
    },
  };
}

// Lexicon type definitions (simplified)
interface LexiconType {
  type: string;
  format?: string;
  const?: string;
  enum?: string[];
  items?: LexiconType;
  properties?: Record<string, LexiconType>;
  required?: string[];
  refs?: string[];
}

interface LexiconObject extends LexiconType {
  type: "object";
  properties: Record<string, LexiconType>;
  required?: string[];
}

interface LexiconUnion extends LexiconType {
  type: "union";
  refs: string[];
}

interface LexiconDoc {
  lexicon: 1;
  id: string;
  defs: {
    main: {
      type: string;
      description?: string;
      properties?: Record<string, LexiconType>;
      required?: string[];
    };
  };
}

// Main execution
function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const [nsid, entry] of Object.entries(allSchemas)) {
    const lexicon = generateLexicon(nsid, entry);
    const filename = `${OUTPUT_DIR}/${nsid}.json`;
    writeFileSync(filename, JSON.stringify(lexicon, null, 2));
    console.log(`Generated: ${filename}`);
  }

  console.log(`\nGenerated ${Object.keys(allSchemas).length} lexicons`);
}

main();
