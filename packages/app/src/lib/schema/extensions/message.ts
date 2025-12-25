/**
 * Message extensions - these are the extensible fields that can be
 * attached to messages (replaces the Kinds2 nested union in SCALE).
 *
 * In ATProto/lexicons, these become separate record types that can
 * be referenced via union.
 */

import { type, Ulid, unionToMap, UserDid } from "../primitives";

// Override author (for bridged messages)
export const AuthorOverride = type({
  $type: "'space.roomy.extension.authorOverride.v0'",
  did: UserDid,
});

// Override timestamp (for bridged messages)
export const TimestampOverride = type({
  $type: "'space.roomy.extension.timestampOverride.v0'",
  /** Unix timestamp in milliseconds */
  timestamp: "number.integer>0",
});

// Reply reference
export const Reply = type({
  $type: "'space.roomy.attachment.reply.v0'",
  target: Ulid,
});

// Comment/annotation on a document
export const Comment = type({
  $type: "'space.roomy.attachment.comment.v0'",
  /** Version of the document being commented on */
  version: Ulid,
  /** Text snippet being referenced */
  snippet: "string",
  /** Start index in document */
  from: "number.integer>=0",
  /** End index in document */
  to: "number.integer>=0",
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

// Link with optional preview
export const LinkAttachment = type({
  $type: "'space.roomy.attachment.link.v0'",
  uri: "string",
  showPreview: "boolean",
});

// Override timestamp (for bridged messages)
export const Attachment = type.or(
  Reply,
  Comment,
  ImageAttachment,
  VideoAttachment,
  FileAttachment,
  LinkAttachment,
);
export type Attachment = typeof Attachment.infer;

// Override timestamp (for bridged messages)
export const Attachments = type({
  $type: "'space.roomy.extension.attachments.v0'",
  /** Unix timestamp in milliseconds */
  attachments: Attachment.array(),
});

// Union of all message extensions
export const messageExtension = type.or(
  AuthorOverride,
  TimestampOverride,
  Attachments,
);

export type MessageExtension = typeof messageExtension.infer;
export const MessageExtensionMap = unionToMap(messageExtension);
export type MessageExtensionMap = typeof MessageExtensionMap.infer;

// Export individual types for the registry
export const extensions = {
  "space.roomy.extension.authorOverride.v0": AuthorOverride,
  "space.roomy.extension.timestampOverride.v0": TimestampOverride,
  "space.roomy.extension.attachments.v0": Attachments,
  "space.roomy.attachment.reply.v0": Reply,
  "space.roomy.attachment.comment.v0": Comment,
  "space.roomy.attachment.image.v0": ImageAttachment,
  "space.roomy.attachment.video.v0": VideoAttachment,
  "space.roomy.attachment.file.v0": FileAttachment,
  "space.roomy.attachment.link.v0": LinkAttachment,
} as const;
