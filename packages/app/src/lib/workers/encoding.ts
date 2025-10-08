/**
 * This module defines a codec creator that uses a string kind before a payload data.
 *
 * It lets you specify a mapping between the kind string and the type of data that should follow it.
 */

import { decodeBase32, encodeBase32 } from "$lib/utils/base32";
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
  Vector,
  u64,
} from "scale-ts";
import { createCodec, str, Tuple } from "scale-ts";

/** encoding */
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

/** decoding */
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
  return createCodec(kindsEnc(e), kindsDec(d)) as any;
};

Kinds.enc = kindsEnc;
Kinds.dec = kindsDec;

export const Hash = enhanceCodec(Bytes(32), hex.decode, hex.encode);

export const Ulid = enhanceCodec(Bytes(16), decodeBase32, (b) =>
  encodeBase32(b).toUpperCase(),
);

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
  "space.roomy.room.parent.update.0": Struct({
    parent: IdCodec,
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
  /** Create a new chat message. */
  "space.roomy.message.create.0": Struct({
    content: Content,
    replyTo: Option(Ulid),
  }),
  /** Edit a previously sent message */
  "space.roomy.message.edit.0": Struct({
    /** The message content */
    content: Content,
    /** The message this message is in reply to, if any. */
    replyTo: Option(Ulid),
    /** List of attached media or other entities. */
    attachments: Vector(Ulid),
  }),
  /**
   * Override a user handle. This is mostly used for bridged accounts, such as Discord accounts
   * where we can not retrieve the handle based on the ID. */
  "space.roomy.user.overrideMeta.0": Struct({
    /** The original handle of the user account on whatever platform it came from. */
    handle: str,
  }),
  /**
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
  /** Create new media that can, for example, be attached to messages. */
  "space.roomy.media.create.0": Struct({
    /** For now all media is external and we use a URI to load it. */
    uri: str,
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
