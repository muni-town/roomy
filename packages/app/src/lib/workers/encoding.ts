/**
 * This module defines a codec creator that uses a string kind before a payload data.
 *
 * It lets you specify a mapping between the kind string and the type of data that should follow it.
 */

import { base32crockford, hex } from "@scure/base";
import {
  Bytes,
  enhanceCodec,
  type Codec,
  type CodecType,
  type Decoder,
  type DecoderType,
  type Encoder,
  type EncoderType,
  createDecoder,
} from "scale-ts";
import { createCodec, str, Tuple } from "scale-ts";

/** encoding */
const enc = <O extends { [key: string]: Encoder<any> }>(
  inner: O,
): Encoder<
  {
    [K in keyof O]: { kind: K; data: EncoderType<O[K]> };
  }[keyof O]
> => {
  return ({ kind, data }) => {
    if (typeof kind !== "string") throw "key must be string";
    const kindEncoder = inner[kind];
    if (!kindEncoder) throw `Unknown kind: ${kind}`;
    return Tuple(str, [kindEncoder] as any).enc([kind, data]);
  };
};

/** decoding */
const dec = <O extends { [key: string]: Decoder<any> }>(
  inner: O,
): Decoder<
  {
    [K in keyof O]: { kind: K; data: DecoderType<O[K]> };
  }[keyof O]
> => {
  return createDecoder((bytes) => {
    const kind = str.dec(bytes);
    const valueDecoder = inner[kind] as O[keyof O];
    if (!valueDecoder) throw `Unknown event kind: ${kind}`;
    return {
      kind,
      data: valueDecoder(bytes),
    };
  });
};

/** Kinds codec creator */
export const Kinds = <O extends { [key: string]: Codec<any> }>(
  inner: O,
): Codec<
  {
    [K in keyof O]: { kind: K; data: CodecType<O[K]> };
  }[keyof O]
> => {
  const e = Object.fromEntries(
    Object.entries(inner).map(([k, v]) => [k, v.enc]),
  );
  const d = Object.fromEntries(
    Object.entries(inner).map(([k, v]) => [k, v.dec]),
  );
  return createCodec(enc(e), dec(d)) as any;
};

Kinds.enc = enc;
Kinds.dec = dec;

export const Hash = enhanceCodec(Bytes(32), hex.decode, hex.encode);

export const Ulid = enhanceCodec(
  Bytes(16),
  base32crockford.decode,
  base32crockford.encode,
);
