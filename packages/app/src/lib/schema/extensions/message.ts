/**
 * Message extensions - these are the extensible fields that can be
 * attached to messages (replaces the Kinds2 nested union in SCALE).
 *
 * In ATProto/lexicons, these become separate record types that can
 * be referenced via union.
 */

import { type, ulid } from "../primitives";

// Reply reference
export const replyTo = type({
  $type: "'space.roomy.extension.replyTo'",
  target: ulid,
});

// Comment/annotation on a document
export const comment = type({
  $type: "'space.roomy.extension.comment'",
  /** Version of the document being commented on */
  version: ulid,
  /** Text snippet being referenced */
  snippet: "string",
  /** Start index in document */
  from: "number.integer>=0",
  /** End index in document */
  to: "number.integer>=0",
});

// Override author (for bridged messages)
export const overrideAuthor = type({
  $type: "'space.roomy.extension.overrideAuthor'",
  did: "string",
});

// Override timestamp (for bridged messages)
export const overrideTimestamp = type({
  $type: "'space.roomy.extension.overrideTimestamp'",
  /** Unix timestamp in milliseconds */
  timestamp: "number.integer>0",
});

// Image attachment
export const image = type({
  $type: "'space.roomy.extension.image'",
  uri: "string",
  mimeType: "string",
  "alt?": "string",
  "height?": "number.integer>0",
  "width?": "number.integer>0",
  "blurhash?": "string",
  "size?": "number.integer>0",
});

// Video attachment
export const video = type({
  $type: "'space.roomy.extension.video'",
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
export const file = type({
  $type: "'space.roomy.extension.file'",
  uri: "string",
  mimeType: "string",
  "name?": "string",
  "size?": "number.integer>0",
});

// Link with optional preview
export const link = type({
  $type: "'space.roomy.extension.link'",
  uri: "string",
  showPreview: "boolean",
});

// Union of all message extensions
export const messageExtension = replyTo
  .or(comment)
  .or(overrideAuthor)
  .or(overrideTimestamp)
  .or(image)
  .or(video)
  .or(file)
  .or(link);

// Export individual types for the registry
export const extensions = {
  "space.roomy.extension.replyTo": replyTo,
  "space.roomy.extension.comment": comment,
  "space.roomy.extension.overrideAuthor": overrideAuthor,
  "space.roomy.extension.overrideTimestamp": overrideTimestamp,
  "space.roomy.extension.image": image,
  "space.roomy.extension.video": video,
  "space.roomy.extension.file": file,
  "space.roomy.extension.link": link,
} as const;
