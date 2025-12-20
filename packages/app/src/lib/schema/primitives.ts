/**
 * Primitive types for the event schema.
 * These are the building blocks used across all event definitions.
 *
 * Lexicon mapping notes:
 * - ulid -> { type: 'string' } (no ulid format in lexicons)
 * - did -> { type: 'string', format: 'did' }
 */

import { type } from "arktype";
import { BytesWrapper, type Bytes as BytesLink } from "@atcute/cbor";
import { isDid } from "@atproto/oauth-client";
import { isValid as isValidUlid, ulid as generateUlid } from "ulidx";

export type Bytes = BytesLink;
export const Bytes = type.or(
  type.instanceOf(BytesWrapper),
  type({ $bytes: "string.base64" }),
);
export { fromBytes } from "@atcute/cbor";

export function toBytes(buf: Uint8Array): BytesLink {
  // Since the BytesWrapper class won't go across the worker boundary correctly, we convert to the
  // plain JSON version.
  return new BytesWrapper(buf).toJSON();
}

export const Ulid = type.string
  .narrow((v, ctx) => (isValidUlid(v) ? true : ctx.mustBe("a valid ULID")))
  .brand("ulid");
export type Ulid = typeof Ulid.infer;

export const newUlid = () => generateUlid() as Ulid;

export const Did = type.string
  .narrow((v, ctx) => (isDid(v) ? true : ctx.mustBe("a valid DID")))
  .brand("did");
export type Did = typeof Did.infer;

export const UserDid = Did.brand("didUser");
export type UserDid = typeof UserDid.infer;

export const StreamDid = Did.brand("didStream");
export type StreamDid = typeof StreamDid.infer;

/** essentially checking if it's a valid-ish domain name. DNS segments can't be longer than 63 chars */
export const isAtProtoHandle = (v: string): boolean => {
  return /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9-]+)+$/.test(v);
};

export const Handle = type.string
  .narrow((v, ctx) =>
    isAtProtoHandle(v) ? true : ctx.mustBe("a valid ATProto Handle"),
  )
  .brand("handle");
export type Handle = typeof Handle.infer;

// Content block: mime type + payload
// In DRISL, content will be bytes; we may want to decode text types
export const Content = type({
  mimeType: "string",
  // For now, keep as bytes. Could refine based on mimeType.
  data: Bytes,
});

// Timestamp: microseconds since Unix epoch
// Lexicons use integer for this
export const Timestamp = type("number.integer>0", "@", "timestamp");

export const StreamIndex = type("number.integer").brand("stream-index");
export type StreamIndex = typeof StreamIndex.infer;

/**
 * Either set a string value or ignore (don't change).
 *
 * Usage:
 * - { $type: "'space.roomy.defs#set'", value: "myvalue" } → update to "new name"
 * - { $type: "'space.roomy.defs#set'", value: null } → update to "new name"
 * - { $type: "'space.roomy.defs#ignore'" } → leave unchanged
 */
export const SetProperty = type.or(
  { $type: "'space.roomy.defs#ignore'" },
  {
    $type: "'space.roomy.defs#set'",
    value: "string | null",
  },
);
export type SetProperty = typeof SetProperty.infer;
export const set: (v: string) => SetProperty = (value) => ({
  $type: "space.roomy.defs#set",
  value,
});
export const ignore: SetProperty = { $type: "space.roomy.defs#ignore" };

// Re-export the type helper for use in other modules
export { type };
