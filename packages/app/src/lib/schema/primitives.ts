/**
 * Primitive types for the event schema.
 * These are the building blocks used across all event definitions.
 *
 * Lexicon mapping notes:
 * - ulid -> { type: 'string' } (no ulid format in lexicons)
 * - did -> { type: 'string', format: 'did' }
 */

import { type } from "arktype";
import { type Bytes as BytesLink } from "@atcute/cbor";
import { isDid } from "@atproto/oauth-client";
import { isValid as isValidUlid, ulid as generateUlid } from "ulidx";

export type Bytes = BytesLink;
export const Bytes = type({ $bytes: "string.base64" });
export { toBytes, fromBytes } from "@atcute/cbor";

export const ulid = type.string
  .narrow((v, ctx) => (isValidUlid(v) ? true : ctx.mustBe("a valid ULID")))
  .brand("ulid");
export type Ulid = typeof ulid.infer;

export const newUlid = () => generateUlid() as Ulid;

export const did = type.string
  .narrow((v, ctx) => (isDid(v) ? true : ctx.mustBe("a valid DID")))
  .brand("did");
export type Did = typeof did.infer;

export const didUser = did.brand("didUser");
export type DidUser = typeof didUser.infer;

export const didStream = did.brand("didStream");
export type DidStream = typeof didStream.infer;

/** essentially checking if it's a valid-ish domain name. DNS segments can't be longer than 63 chars */
export const isAtProtoHandle = (v: string): boolean => {
  return /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9-]+)+$/.test(v);
};

export const handle = type.string
  .narrow((v, ctx) =>
    isAtProtoHandle(v) ? true : ctx.mustBe("a valid ATProto Handle"),
  )
  .brand("handle");
export type Handle = typeof handle.infer;

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
 * Either set a string value or ignore (don't change).
 *
 * Usage:
 * - { set: "new name" } → update to "new name"
 * - { set: null } → clear the value
 * - { ignore: null } → leave unchanged
 */
const setVariant = type({
  $type: "'space.roomy.defs#set'",
  value: "string | null",
});
type SetVariant = typeof setVariant.infer;
const ignoreVariant = type({ $type: "'space.roomy.defs#ignore'" });
type IgnoreVariant = typeof ignoreVariant.infer;
export const setProperty = setVariant.or(ignoreVariant);
export type SetPropety = typeof setProperty.infer;

export const set = (value: string) =>
  ({ $type: "space.roomy.defs#set", value }) satisfies SetVariant;

export const ignore = {
  $type: "space.roomy.defs#ignore",
} satisfies IgnoreVariant;

// Re-export the type helper for use in other modules
export { type };
