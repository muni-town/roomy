/**
 * Primitive types for the event schema.
 * These are the building blocks used across all event definitions.
 *
 * Lexicon mapping notes:
 * - ulid -> { type: 'string' } (no ulid format in lexicons)
 * - hash -> { type: 'string' } (could use description to note it's hex)
 * - did -> { type: 'string', format: 'did' }
 * - cid -> { type: 'cid' } (lexicons have native cid support)
 */

import { type, Type } from "arktype";
import { type Bytes as BytesLink } from "@atcute/cbor";
import { isDid } from "@atproto/oauth-client";
import { isValid as isValidUlid } from "ulidx";

export type Bytes = BytesLink;
export const Bytes = type({ $bytes: "string.base64" });

export const ulid = type.string
  .narrow((v, ctx) => (isValidUlid(v) ? true : ctx.mustBe("a valid ULID")))
  .brand("ulid");
export type Ulid = typeof ulid.infer;

export const did = type.string
  .narrow((v, ctx) => (isDid(v) ? true : ctx.mustBe("a valid DID")))
  .brand("did");
export type Did = typeof did.infer;

// Hash: 64 hex characters (SHA-256)
// In DRISL this is 32 bytes, decoded to hex string
export const hash = type(/^[A-Fa-f0-9]{64}$/, "@", "hash");

// CID: Content Identifier (IPFS-style)
// Lexicons have native 'cid' format support
// This is a simplified pattern - real CIDs have more structure
export const cid = type(/^b[a-z2-7]+$/, "@", "cid");

// Content block: mime type + payload
// In DRISL, content will be bytes; we may want to decode text types
export const content = type({
  mimeType: "string",
  // For now, keep as bytes. Could refine based on mimeType.
  content: Bytes,
});

// Timestamp: microseconds since Unix epoch
// Lexicons use integer for this
export const timestamp = type("number.integer>0", "@", "timestamp");

/**
 * Value update wrapper - either set a value or ignore (don't change).
 *
 * Usage:
 * - { set: "new name" } → update to "new name"
 * - { set: null } → clear the value
 * - { ignore: null } → leave unchanged
 */
export const stringUpdate = type({ set: "string | null" }).or({
  ignore: "null",
});

// Re-export the type helper for use in other modules
export { type };
