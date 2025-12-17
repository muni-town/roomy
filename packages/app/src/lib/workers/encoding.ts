/**
 * This module defines a codec creator that uses a string kind before a payload data.
 *
 * It lets you specify a mapping between the kind string and the type of data that should follow it.
 */

import { type } from "arktype";
import { isDid } from "@atproto/oauth-client";
import { isValid as isValidUlid } from "ulidx";
import { type Bytes as BytesLink } from "@atcute/cbor";

export const Ulid = type.string.narrow((v, ctx) =>
  isValidUlid(v) ? true : ctx.mustBe("a valid ULID"),
).brand("ulid");
export type Ulid = typeof Ulid.infer;

export const Did = type.string.narrow((v, ctx) =>
  isDid(v) ? true : ctx.mustBe("a valid DID"),
).brand("did");
export type Did = typeof Did.infer;

export type Bytes = BytesLink;
export const Bytes = type({ $bytes: "string.base64" });

// /** Read permission or write permission */
// export const ReadOrWrite = Enum({
//   read: _void,
//   write: _void,
// });

// /** Codec for a member in a group. */
// export const GroupMember = Enum({
//   /** Everybody, including unauthenticated users. */
//   anonymous: _void,
//   /** Authenticated users that have joined the space. */
//   authenticated: _void,
//   /** A user ID. */
//   user: str,
//   /** The ID of another room to use as a group. That room's member list will be used. */
//   room: Ulid,
// });

export const StringUpdate = type.or(
  {
  "$type": "'space.roomy.defs.setProperty.value'",
  "value": "string | null"
}, {
  "$type": "'space.roomy.setProperty.ignore'"
})

export const Content = type({
  /** The Mime type of the message content */
  mimeType: "string",
  /**
   * The actual content. This is usually going to be text, but we allow freeform binary data here
   * just in case.
   *
   * The mime type will specify the precise encoding.
   * */
  content: Bytes,
});

export const eventVariantCodec = type.or(
  {
    /** Join a Roomy space: used to track joined spaces in the user's personal space. */
    "space.roomy.space.join.0": {
      spaceDid: Did,
    },
  },

    {

    /** Leave a Roomy space: used to track joined spaces in the users personal space. */
    "space.roomy.space.leave.0": {
      spaceDid: Did,
    },
    },
    {
      "space.roomy.admin.add.0": {
        userDid: Did,
      }
    },
    {

  "space.roomy.admin.remove.0": {
    userDid: Did,
  }
    },
  /**
   * The parent of the event indicates which room is being joined.
   *
   * When the parent is undefined, then that means that the user is publicly announcing that they
   * are joining the space.
   */
  "space.roomy.room.join.0",
  /** The parent of the event indicates which room is being left. */
  "space.roomy.room.leave.0",
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
  {

  "space.roomy.stream.handle.account.0": {
    "did?": Did,
  }
  },
  {

  /**
   * Set some entity's basic info. This is used for Rooms and possibly other things, too
   */
  "space.roomy.info.0": {
    name: StringUpdate,
    avatar: StringUpdate,
    description: StringUpdate,
  }
  },
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
  "space.roomy.room.create.0",
  /** Delete a room */
  "space.roomy.room.delete.0",
  /** Change the parent of a room. */
  {

  "space.roomy.parent.update.0": {
    parent: type.string.optional(),
  }
  },
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
  /** Set a 'kind' for a room */
  "space.roomy.room.kind.0": Kinds2({
    "space.roomy.channel.0": _void,
    "space.roomy.category.0": _void,
    "space.roomy.thread.0": _void,
    "space.roomy.page.0": _void,
  }),
  /**
   *
   * Deprecated Events
   *
   */
  /** Mark/unmark events are replaced by "space.roomy.room.kind.0" */
  /** DEPRECATED - Mark a room as a channel. */
  "space.roomy.channel.mark.0": _void,
  /** DEPRECATED - Unmark a room as a channel. */
  "space.roomy.channel.unmark.0": _void,
  /** DEPRECATED - Mark a room as a category. */
  "space.roomy.category.mark.0": _void,
  /** DEPRECATED - Unmark a room as a category. */
  "space.roomy.category.unmark.0": _void,
  /** DEPRECATED - Mark a room as a thread. */
  "space.roomy.thread.mark.0": _void,
  /** DEPRECATED - Unmark a room as a thread. */
  "space.roomy.thread.unmark.0": _void,
  /** DEPRECATED - Mark a room as a page. */
  "space.roomy.page.mark.0": _void,
  /** DEPRECATED - Unmark a room as a thread. */
  "space.roomy.page.unmark.0": _void,
  /** DEPRECATED - replaced by space.roomy.message.create.1
   * Create a new chat message. */
  "space.roomy.message.create.0": Struct({
    content: Content,
    replyTo: Option(Ulid),
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
  /** DEPRECATED - replaced by space.roomy.message.create.1
   * Create new media that can, for example, be attached to messages. */
  "space.roomy.media.create.0": Struct({
    /** For now all media is external and we use a URI to load it. */
    uri: str,
    mimeType: str,
  }),
);

export const eventCodec = Struct({
  /** The ULID here serves to uniquely represent the event and provide a timestamp. */
  ulid: Ulid,
  /** The room that the event is sent in. If none, it is considered to be at the space level. */
  parent: Option(IdCodec),
  /** The event variant. */
  variant: eventVariantCodec,
});
