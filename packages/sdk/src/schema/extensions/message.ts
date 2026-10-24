import { type } from "arktype";
import { Timestamp, Ulid, unionToMap, UserDid } from "../primitives";
import { DiscordSnowflake, MatrixRoomId } from "./room";

export const AuthorOverride = type({
  $type: "'space.roomy.extension.authorOverride.v0'",
  did: UserDid,
}).describe(
  "An override for the author of the message. \
This is often used to set the original author of a bridged chat message.",
);

export const TimestampOverride = type({
  $type: "'space.roomy.extension.timestampOverride.v0'",
  timestamp: Timestamp,
}).describe(
  "An override for the timestamp of the message. \
This is often used to set the time that a bridged message was originally sent.",
);

export const Reply = type({
  $type: "'space.roomy.attachment.reply.v0'",
  target: Ulid.describe("The ID of the message being replied to."),
}).describe("Marks the message a reply to the target message.");

// Comment/annotation on a document
export const Comment = type({
  $type: "'space.roomy.attachment.comment.v0'",
  version: Ulid.describe("The version of the document being commented on."),
  snippet: type.string.describe("Text snippet being referenced."),
  from: type("number.integer>=0").describe("Start index in document."),
  to: type("number.integer>=0").describe("End index in document."),
});

// Image attachment
export const ImageAttachment = type({
  $type: "'space.roomy.attachment.image.v0'",
  uri: "string",
  mimeType: "string",
  "alt?": "string",
  "height?": "number.integer>0",
  "width?": "number.integer>0",
  "blurhash?": "string",
  "size?": "number.integer>0",
});

// Video attachment
export const VideoAttachment = type({
  $type: "'space.roomy.attachment.video.v0'",
  uri: "string",
  mimeType: "string",
  "alt?": "string",
  "height?": "number.integer>0",
  "width?": "number.integer>0",
  /** Duration in seconds */
  "length?": "number.integer>=0",
  "blurhash?": "string",
  "size?": "number.integer>0",
});

// File attachment
export const FileAttachment = type({
  $type: "'space.roomy.attachment.file.v0'",
  uri: "string",
  mimeType: "string",
  "name?": "string",
  "size?": "number.integer>0",
});

export const LinkAttachment = type({
  $type: "'space.roomy.attachment.link.v0'",
  uri: "string",
  showPreview: "boolean",
}).describe("Link with optional preview");

// Forward attachment: a message that quotes/embeds another message. This is
// the modern representation of a message forward — a `createMessage` event
// carrying a forward attachment creates a real message in the destination
// room (with the forwarder's own body, if any) plus a `forward` edge to the
// original. The client renders the original as an embed inside the new
// message. Supersedes the legacy `space.roomy.message.forwardMessages.v0`
// event (kept for backwards compatibility).
export const Forward = type({
  $type: "'space.roomy.attachment.forward.v0'",
  target: Ulid.describe("The ID of the original message being forwarded."),
  fromRoomId: Ulid.describe(
    "The room the original message currently lives in.",
  ),
}).describe(
  "Marks the message as a forward of the target message, rendered as an embed.",
);

/**
 * A Web Tile attached to the message.
 *
 * The tile is an `ing.dasl.masl` record, so its only address is that record's
 * AT-URI. `data` is the JSON the tile is handed once loaded, over the tiles
 * data-passing protocol; it is the message author's, not the tile's, and the
 * tile has no other channel to the host.
 *
 * There is no `title`: the tile's own manifest names it.
 */
export const TileAttachment = type({
  $type: "'space.roomy.attachment.tile.v0'",
  uri: type.string.describe(
    "AT-URI of the Web Tile: at://<did:plc:…>/ing.dasl.masl/<rkey>.",
  ),
  "data?": type("unknown").describe(
    "Arbitrary JSON handed to the tile through the data-passing protocol.",
  ),
}).describe("A Web Tile attached to the message, with the data it renders.");

export const DiscordMessageOrigin = type({
  $type: "'space.roomy.extension.discordMessageOrigin.v0'",
  snowflake: DiscordSnowflake.describe("The Discord message snowflake ID."),
  channelId: DiscordSnowflake.describe("The Discord channel snowflake ID."),
  guildId: DiscordSnowflake.describe(
    "The Discord guild (server) snowflake ID.",
  ),
}).describe(
  "Origin metadata for messages bridged from Discord. \
Used for idempotency checks and linking back to Discord.",
);

export const MatrixMessageOrigin = type({
  $type: "'space.roomy.extension.matrixMessageOrigin.v0'",
  roomId: MatrixRoomId.describe(
    "The Matrix room ID the message was bridged from.",
  ),
  "eventId?": type.string.describe(
    "The Matrix event ID of the original message.",
  ),
  "originServerTs?": type("number.integer").describe(
    "The origin server timestamp of the Matrix event, in milliseconds since the unix epoch.",
  ),
}).describe(
  "Origin metadata for messages bridged from Matrix. \
Used for idempotency checks and linking back to Matrix.",
);

export const Attachment = type.or(
  Reply,
  Comment,
  ImageAttachment,
  VideoAttachment,
  FileAttachment,
  LinkAttachment,
  Forward,
  TileAttachment,
);
export type Attachment = typeof Attachment.infer;

export const Attachments = type({
  $type: "'space.roomy.extension.attachments.v0'",
  attachments: Attachment.array().describe("The list of attachments."),
}).describe("Attachments to the message, like files, link embeds, or images.");

/**
 * @deprecated Mentions now fold into `#didMention` facets in the rich text
 * body (`application/vnd.roomy.richtext+json`). This sidecar is kept for the
 * transition window and will be removed after all producers emit facets.
 */
export const Mentions = type({
  $type: "'space.roomy.extension.mentions.v0'",
  mentions: UserDid.array().describe(
    "DIDs of users mentioned in the message body. \
Used by the push pipeline to route Quiet/Engaged immediate notifications. \
Each DID must appear at most once; order is not significant.",
  ),
}).describe(
  "User mentions carried as structured data for notification routing.",
);

// Union of all message extensions
export const messageExtension = type.or(
  AuthorOverride,
  TimestampOverride,
  Attachments,
  DiscordMessageOrigin,
  MatrixMessageOrigin,
  Mentions,
);

export type MessageExtension = typeof messageExtension.infer;
export const MessageExtensionMap = unionToMap(messageExtension).describe(
  "A mapping of extensions to add. Each extension is optional.",
);
export type MessageExtensionMap = typeof MessageExtensionMap.infer;

export const MessageExtensionUpdateMap = unionToMap(messageExtension, {
  makeAllNullable: true,
}).describe(
  "A list of extensions to update. \
Setting an extension to `null` will remove it. \
Any extension not specified will be left as-is.",
);
export type MessageExtensionUpdateMap = typeof MessageExtensionUpdateMap.infer;

export const MessageExtensionDeleteMap = unionToMap(
  type.or(DiscordMessageOrigin, MatrixMessageOrigin), // only bridge origins are relevant
);
export type MessageExtensionDeleteMap = typeof MessageExtensionDeleteMap.infer;
