import { type } from "arktype";
import { Timestamp, Ulid, unionToMap, UserDid } from "../primitives";
import { DiscordSnowflake } from "./room";

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

export const Attachment = type.or(
  Reply,
  Comment,
  ImageAttachment,
  VideoAttachment,
  FileAttachment,
  LinkAttachment,
);
export type Attachment = typeof Attachment.infer;

export const Attachments = type({
  $type: "'space.roomy.extension.attachments.v0'",
  attachments: Attachment.array().describe("The list of attachments."),
}).describe("Attachments to the message, like files, link embeds, or images.");

// Union of all message extensions
export const messageExtension = type.or(
  AuthorOverride,
  TimestampOverride,
  Attachments,
  DiscordMessageOrigin,
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
  type.or(DiscordMessageOrigin), // only the discord origin is relevant
);
export type MessageExtensionDeleteMap = typeof MessageExtensionDeleteMap.infer;
