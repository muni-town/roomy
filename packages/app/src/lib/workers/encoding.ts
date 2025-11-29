/**
 * This module defines a codec creator that uses a string kind before a payload data.
 *
 * It lets you specify a mapping between the kind string and the type of data that should follow it.
 */

import { hex } from "@scure/base";
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
  Option,
  Enum,
  _void,
  Struct,
  u64,
  u32,
  u16,
  compact,
  Vector,
  bool,
} from "scale-ts";
import { createCodec, str, Tuple } from "scale-ts";

/** encoding -
 * old version for compatibility,
 * but should be removed when Leaf changes hit */
const kindsEnc = <O extends { [key: string]: Encoder<any> }>(
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

/** decoding -
 * old version for compatibility,
 * but should be removed when Leaf changes hit */
const kindsDec = <O extends { [key: string]: Decoder<any> }>(
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

/** Kinds codec creator -
 * old version for compatibility,
 * but should be removed when Leaf changes hit */
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
  return createCodec(kindsEnc(e), kindsDec(d)) as any;
};

Kinds.enc = kindsEnc;
Kinds.dec = kindsDec;

/** Custom 'Kinds' codec: encoding function
 * extensible kinds, adds length prefix so data
 * that compose unknown kinds can be decoded
 *
 * NOTE: This encoder was fixed to properly concatenate bytes. Previous versions
 * used Tuple() which created malformed output. Data encoded with the old version
 * cannot be decoded and requires a cache reset.
 */
const kinds2Enc = <O extends { [key: string]: Encoder<any> }>(
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

    // Encode the data first to get its size
    const encodedData = kindEncoder(data);

    // Manually concatenate: kind_string + compact_size + data_bytes
    const kindBytes = str.enc(kind);
    const sizeBytes = compact.enc(encodedData.length);

    // Concatenate all parts
    const result = new Uint8Array(
      kindBytes.length + sizeBytes.length + encodedData.length,
    );
    result.set(kindBytes, 0);
    result.set(sizeBytes, kindBytes.length);
    result.set(encodedData, kindBytes.length + sizeBytes.length);

    return result;
  };
};

/** Custom 'Kinds' codec: decoding function
 * Unknown kinds can still be decoded as raw bytes,
 * meaning kinds can safely be extended in the future
 * with backward compatibility
 */
const kinds2Dec = <O extends { [key: string]: Decoder<any> }>(
  inner: O,
): Decoder<
  | {
      [K in keyof O]: { kind: K; data: DecoderType<O[K]> };
    }[keyof O]
  | { kind: string; data: Uint8Array }
> => {
  return createDecoder((bytes) => {
    // Decode the kind string
    const kind = str.dec(bytes);

    // Decode the data size
    const dataSize = compact.dec(bytes) as number;

    // Validate dataSize is reasonable
    if (dataSize < 0 || dataSize > 100_000_000) {
      throw new Error(
        `Invalid dataSize ${dataSize} for kind "${kind}". This suggests data corruption or encoding/decoding mismatch.`,
      );
    }

    // Check if we have a decoder for this kind
    const valueDecoder = inner[kind] as O[keyof O] | undefined;

    if (!valueDecoder) {
      // Unknown kind: read the raw bytes and return them
      const rawData = Bytes(dataSize).dec(bytes);
      return {
        kind,
        data: rawData,
      };
    }

    // Known kind: decode the data normally
    // Extract the bytes for this variant
    const rawBytes = Bytes(dataSize).dec(bytes);
    // Create a completely fresh Uint8Array with its own ArrayBuffer to avoid DataView issues
    // Using Uint8Array.from ensures we get a new buffer, not a view
    const variantBytes = Uint8Array.from(rawBytes);
    const data = valueDecoder(variantBytes);

    return {
      kind,
      data,
    };
  });
};

/** 'Kinds' codec creator
 * Kinds is like an enum, but SCALE enums by default use a numeric index
 * to indicate the variant. Kinds uses a string identifier instead.
 *
 * This version supports unknown kinds by encoding the data size
 * before the data, allowing future extensions while maintaining
 * backward compatibility.
 */
export const Kinds2 = <O extends { [key: string]: Codec<any> }>(
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
  return createCodec(kinds2Enc(e), kinds2Dec(d)) as any;
};

Kinds2.enc = kinds2Enc;
Kinds2.dec = kinds2Dec;

export const Hash = enhanceCodec(Bytes(32), hex.decode, hex.encode);

export const Ulid = enhanceCodec(Bytes(16), crockfordDecode, crockfordEncode);

type InlineTagged<C extends Codec<any>> =
  CodecType<C> extends { tag: infer Tag; value: infer Value }
    ? Tag extends string
      ? { [K in Tag]: Value }
      : never
    : never;
const inlineTagged = <C extends Codec<any>>(codec: C) =>
  enhanceCodec<CodecType<C>, InlineTagged<C>>(
    codec,
    (id) => {
      const entry = Object.entries(id)[0];
      if (!entry) throw "Invalid ID type";
      return { tag: entry[0], value: entry[1] } as any;
    },
    (id) => {
      return { [id.tag]: id.value } as any;
    },
  );

const rawIdCodec = Enum({
  unknown: str,
  ulid: Ulid,
  hash: Hash,
  did: enhanceCodec<string, string>(
    str,
    (s) => {
      if (s.startsWith("did:")) {
        return s;
      } else {
        throw new Error(`DID is not valid: ${s}`);
      }
    },
    (s) => {
      if (s.startsWith("did:")) {
        return s;
      } else {
        throw new Error(`DID is not valid: ${s}`);
      }
    },
  ),
});
export const IdCodec = enhanceCodec<CodecType<typeof rawIdCodec>, string>(
  rawIdCodec,
  (id: string) => {
    if (id.startsWith("did:")) {
      return { tag: "did", value: id };
    } else if (id.match(/^[A-Fa-f0-9]{64}$/)) {
      return { tag: "hash", value: id };
    } else if (id.match(/^[\da-hjkmnp-tv-z]{26}$/iu)) {
      return { tag: "ulid", value: id };
    } else {
      return { tag: "unknown", value: id };
    }
  },
  ({ value }) => value,
);

/** Encode an ID to it's binary format */
export const id = IdCodec.enc;

export const ValueUpdate = <T>(ty: Codec<T>) =>
  inlineTagged(
    Enum({
      set: ty,
      ignore: _void,
    }),
  );

/** Read permission or write permission */
export const ReadOrWrite = Enum({
  read: _void,
  write: _void,
});

/** Codec for a member in a group. */
export const GroupMember = Enum({
  /** Everybody, including unauthenticated users. */
  anonymous: _void,
  /** Authenticated users that have joined the space. */
  authenticated: _void,
  /** A user ID. */
  user: str,
  /** The ID of another room to use as a group. That room's member list will be used. */
  room: Ulid,
});

/** Content encoding. */
export const Content = Struct({
  /** The Mime type of the message content */
  mimeType: str,
  /**
   * The actual content. This is usually going to be text, but we allow freeform binary data here
   * just in case.
   *
   * The mime type will specify the precise encoding.
   * */
  content: Bytes(),
});

export const eventVariantCodec = Kinds({
  /** Join a Roomy space: used to track joined spaces in the user's personal space. */
  "space.roomy.space.join.0": Struct({
    spaceId: Hash,
  }),
  /** Leave a Roomy space: used to track joined spaces in the users personal space. */
  "space.roomy.space.leave.0": Struct({
    spaceId: Hash,
  }),
  "space.roomy.admin.add.0": Struct({
    adminId: str,
  }),
  "space.roomy.admin.remove.0": Struct({
    adminId: str,
  }),
  /**
   * The parent of the event indicates which room is being joined.
   *
   * When the parent is undefined, then that means that the user is publicly announcing that they
   * are joining the space.
   */
  "space.roomy.room.join.0": _void,
  /** The parent of the event indicates which room is being left. */
  "space.roomy.room.leave.0": _void,
  /**
   * This event sets the ATProto account did that should be used as the handle for this space.
   *
   * For this to be verified that account also has to have a `space.roomy.stream` PDS record with an
   * rkey of `handle` and an `id` value that is set to this streams ID.
   *
   * When both the stream points to the ATProto account, and the ATProto account points to the
   * stream ID, then that makes a verified Roomy space handle so you can visit the space at
   * `https://roomy.space/example.handle`.
   */
  "space.roomy.stream.handle.account.0": Struct({
    did: Option(str),
  }),
  /**
   * Set some entity's basic info. This is used for Rooms and possibly other things, too
   */
  "space.roomy.info.0": Struct({
    name: ValueUpdate(Option(str)),
    avatar: ValueUpdate(Option(str)),
    description: ValueUpdate(Option(str)),
  }),
  // TODO: It might make sense to move these parent events up out of the event variant and into the
  // envelope because they are fundamental and will need to be read by the auth implementation,
  // while all the other event variants are informative, indifferent to auth, and possibly
  // client-specific.
  /**
   * A room is the most general container smaller than a space for events.
   *
   * Each event has a room that it is a part of except for top-level events which considered at the
   * space level.
   *
   * If a room.create event is sent in another room, it creates a sub-room.
   *
   * The read and write groups are then allowed to inherit from it's parent room.
   *
   * Creator of a room, and admins, should be allowed to modify the read group and write group of
   * the room and therefor control access to the room.
   *
   * Every event can be treated as a "room" by having other events target it as a parent. If there
   * has not been a read/write groups specified for an event, though, for example, by using a
   * `room.update` event, only the creator of the event ( and admins ) are allowed to send events
   * that target it as a parent.
   *
   * For example, chat message, when sent, can have edit and overrideMeta events sent by the
   * messages author that have the original message event as it's parent.
   * */
  "space.roomy.room.create.0": _void,
  /** Delete a room */
  "space.roomy.room.delete.0": _void,
  /** Change the parent of a room. */
  "space.roomy.parent.update.0": Struct({
    parent: Option(IdCodec),
  }),
  /**
   * Add a member to the Room's member list. Each room has a member list, and some Rooms are created
   * intentionally to use as groups, so that their member list is all they are used for.
   *
   * Each member is granted either read or write access to the room.
   * */
  "space.roomy.room.member.add.0": Struct({
    member_id: GroupMember,
    access: ReadOrWrite,
  }),
  /**
   * Remove a member from the room. A reason may be supplied to clarify in case of, for example, a
   * ban.
   */
  "space.roomy.room.member.remove.0": Struct({
    member_id: GroupMember,
    access: ReadOrWrite,
    reason: Option(str),
  }),
  /** DEPRECATED - replaced by space.roomy.message.create.1
   * Create a new chat message. */
  "space.roomy.message.create.0": Struct({
    content: Content,
    replyTo: Option(Ulid),
  }),
  /** Create a new chat message, v1.
   * This version adds support for extensible fields,
   * using backwards compatible Kinds2 codec
   * Attachments, etc are now encapsulated within the message event,
   * do not require separate 'media.create' events
   */
  "space.roomy.message.create.1": Struct({
    content: Content,
    extensions: Vector(
      Kinds2({
        "space.roomy.replyTo.0": Ulid,
        "space.roomy.comment.0": Struct({
          version: Ulid,
          snippet: str,
          from: u32, // document index
          to: u32, // document index
        }),
        "space.roomy.overrideAuthorDid.0": str,
        "space.roomy.overrideTimestamp.0": u64, // unix
        "space.roomy.image.0": Struct({
          uri: str,
          mimeType: str,
          alt: Option(str),
          height: Option(u16), // pixels
          width: Option(u16), // pixels
          blurhash: Option(str),
          size: Option(u32), // bytes
        }),
        "space.roomy.video.0": Struct({
          uri: str,
          mimeType: str,
          alt: Option(str),
          height: Option(u16), // pixels
          width: Option(u16), // pixels
          length: Option(u16), // seconds
          blurhash: Option(str), // thumbnail
          size: Option(u32), // bytes
        }),
        "space.roomy.file.0": Struct({
          uri: str,
          mimeType: str,
          name: Option(str),
          size: Option(u32), // bytes
        }),
        "space.roomy.link.0": Struct({
          uri: str,
          showPreview: bool,
        }),
      }),
    ),
  }),
  /** Edit a previously sent message */
  "space.roomy.message.edit.0": Struct({
    /**
     * The message content. Depending on the mime-type this will replace the previous value.
     *
     * By default, the new content will replace the original content entirely, but there is a
     * convention that if the mime-type of the new content is text/x-dmp-diff ( diff-match-patch
     * diff ) then the new content will be applied as a diff to previous content to produce the new
     * value.
     * */
    content: Content,
    /** The message this message is in reply to, if any. This will replace the previous value. */
    replyTo: Option(Ulid),
  }),
  /**
   * Override a user handle. This is mostly used for bridged accounts, such as Discord accounts
   * where we can not retrieve the handle based on the ID. */
  "space.roomy.user.overrideMeta.0": Struct({
    /** The original handle of the user account on whatever platform it came from. */
    handle: str,
  }),
  /**
   * DEPRECATED - replaced by space.roomy.message.create.1
   * Set an override for the author and timestamp of a previously sent message. This is used by chat
   * bridges, to send messages as remote users. */
  "space.roomy.message.overrideMeta.0": Struct({
    /** The override for the author ID. */
    author: str,
    /** The override for the unix timestamp in milliseconds. */
    timestamp: u64,
  }),
  /** Delete a message. */
  "space.roomy.message.delete.0": Struct({
    reason: Option(str),
  }),
  /** Create a reaction to a message. */
  "space.roomy.reaction.create.0": Struct({
    /** The message that is being reacted to. */
    reactionTo: Ulid,
    /**
     * This is usually a unicode code point, and otherwise should be a URI describing the reaction.
     * */
    reaction: str,
  }),
  /** Delete a reaction. */
  "space.roomy.reaction.delete.0": Struct({
    reaction_to: Ulid,
    reaction: str,
  }),
  /** Create a bridged reaction. This is similar to a normal reaction except it allows you to
   * specify an alternative user ID for who is doing the reacting. */
  "space.roomy.reaction.bridged.create.0": Struct({
    reactionTo: Ulid,
    reaction: str,
    reactingUser: str,
  }),
  "space.roomy.reaction.bridged.delete.0": Struct({
    reaction_to: Ulid,
    reaction: str,
    reactingUser: str,
  }),
  /** DEPRECATED - replaced by space.roomy.message.create.1
   * Create new media that can, for example, be attached to messages. */
  "space.roomy.media.create.0": Struct({
    /** For now all media is external and we use a URI to load it. */
    uri: str,
    mimeType: str,
  }),
  "space.roomy.page.edit.0": Struct({
    /**
     * This content contains a mime-type and the actual content of the edit.
     *
     * If the mime type of the edit is just something like text/markdown then it will completely
     * replace the previous content. Usually it will be text/x-dmp-diff indicating a
     * meyers-algorithm patch to the previous content, allowing us to display and apply a precise
     * edit history.
     * **/
    content: Content,
  }),
  "space.roomy.media.delete.0": _void,
  /** Mark a room as a channel. */
  "space.roomy.channel.mark.0": _void,
  /** Unmark a room as a channel. */
  "space.roomy.channel.unmark.0": _void,
  /** Mark a room as a category. */
  "space.roomy.category.mark.0": _void,
  /** Unmark a room as a category. */
  "space.roomy.category.unmark.0": _void,
  /** Mark a room as a thread. */
  "space.roomy.thread.mark.0": _void,
  /** Unmark a room as a thread. */
  "space.roomy.thread.unmark.0": _void,
  /** Mark a room as a page. */
  "space.roomy.page.mark.0": _void,
  /** Unmark a room as a thread. */
  "space.roomy.page.unmark.0": _void,
  /**
   * Mark a room as read by the user. This event is sent to the user's personal stream
   * to track when they last visited/read a room. The ULID timestamp encodes when the
   * room was last read.
   */
  "space.roomy.room.lastRead.0": Struct({
    /** The ID of the room being marked as read (channel, thread, page, etc). */
    roomId: Ulid,
    /** The stream ID that contains the room. */
    streamId: Hash,
  }),
});

export const eventCodec = Struct({
  /** The ULID here serves to uniquely represent the event and provide a timestamp. */
  ulid: Ulid,
  /** The room that the event is sent in. If none, it is considered to be at the space level. */
  parent: Option(IdCodec),
  /** The event variant. */
  variant: eventVariantCodec,
});

export const streamParamsCodec = Struct({
  /** The type of stream as an NSID. */
  streamType: str,
  /** The stream schema version from $lib/config.ts CONFIG.streamSchemaVersion. */
  schemaVersion: str,
});

// Code from https://github.com/perry-mitchell/ulidx/blob/5043c511406fb9b836ddf126583c80ffb90cbb73/source/crockford.ts
// We already use ulidx but encoding is not exposed so we copy the functions here.
const B32_CHARACTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function crockfordEncode(input: Uint8Array): string {
  const output: number[] = [];
  let bitsRead = 0;
  let buffer = 0;
  const reversedInput = new Uint8Array(input.slice().reverse());
  for (const byte of reversedInput) {
    buffer |= byte << bitsRead;
    bitsRead += 8;

    while (bitsRead >= 5) {
      output.unshift(buffer & 0x1f);
      buffer >>>= 5;
      bitsRead -= 5;
    }
  }
  if (bitsRead > 0) {
    output.unshift(buffer & 0x1f);
  }
  return output.map((byte) => B32_CHARACTERS.charAt(byte)).join("");
}
export function crockfordDecode(input: string): Uint8Array {
  const sanitizedInput = input.toUpperCase().split("").reverse().join("");
  const output: number[] = [];
  let bitsRead = 0;
  let buffer = 0;
  for (const character of sanitizedInput) {
    const byte = B32_CHARACTERS.indexOf(character);
    if (byte === -1) {
      throw new Error(
        `Invalid base 32 character found in string: ${character}`,
      );
    }
    buffer |= byte << bitsRead;
    bitsRead += 5;
    while (bitsRead >= 8) {
      output.unshift(buffer & 0xff);
      buffer >>>= 8;
      bitsRead -= 8;
    }
  }
  if (bitsRead >= 5 || buffer > 0) {
    output.unshift(buffer & 0xff);
  }
  return new Uint8Array(output);
}
