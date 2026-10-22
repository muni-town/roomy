/**
 * Shared Message schema, used by both `room.getMessages` and
 * `message.getMessage` responses, and by the `#messageDiff` WS frame.
 * Mirrors packages/appserver/src/queries/selectMessages.ts MessageDto.
 *
 * The schemas live in an arktype `scope` so `Message` and `ForwardedFrom`
 * can reference each other: a forward's `forwardedFrom.message` is itself a
 * full `Message` (fully denormalised server-side, including its own
 * `forwardedFrom` chain for nested forwards).
 *
 * A message's attachments arrive as `attachments: AttachmentDto[]` — one
 * entry per attachment, each discriminated by its `$type`. `media`,
 * `linkEmbeds`, `replyTo` and `forwardedFrom` are the per-kind views the
 * renderers were built against, derived server-side from that one list while
 * those renderers migrate. A renderer can therefore dispatch on kind, which
 * the flat `Media` shape does not allow.
 */
import { scope } from "arktype";

const Schemas = scope({
  Reaction: {
    emoji: "string",
    count: "number",
    /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
    "myReactionId?": "string",
  },

  Media: {
    url: "string",
    type: "string",
    "alt?": "string",
    "width?": "number",
    "height?": "number",
    "blurhash?": "string",
    "size?": "number",
    "length?": "number",
    "name?": "string",
  },

  /**
   * Metadata for a forward: where the original lives, plus the fully
   * denormalised original message itself (`message`), which the client
   * renders directly — no extra fetch needed.
   */
  ForwardedFrom: {
    /** The ID of the original message that was forwarded. */
    messageId: "string",
    /** The room the original message lives in. */
    roomId: "string",
    /** The name of the source room. */
    name: "string",
    /**
     * The fully denormalised original message (author, content, timestamp,
     * reactions, media, linkEmbeds, and its own `forwardedFrom` chain when
     * the original is itself a forward). Absent when the original couldn't
     * be resolved (e.g. deleted or not yet materialised).
     */
    "message?": "Message",
  },

  /**
   * A link embed with optional enriched metadata from the embed service.
   * The `embed` field contains the EmbedV1 JSON object when enrichment has
   * completed; it's absent/null when still pending or when the service had
   * no data for the URL.
   *
   * The embed data follows the Lantern-chat embed-service protocol:
   * https://github.com/Lantern-chat/embed-service
   */
  LinkEmbedData: {
    "t?": "string",
    "d?": "string",
    /** Provider info from oEmbed. */
    "p?": { "n?": "string", "u?": "string" },
    /** Author info from OpenGraph. */
    "au?": { "n?": "string", "u?": "string" },
    /** Footer text. */
    "footer?": { "t?": "string" },
    /** Minimal media reference within an embed (image, video, thumbnail). */
    "imgs?": "EmbedMedia[]",
    "vid?": "EmbedMedia",
    "thumb?": "EmbedMedia",
  },

  /** Minimal media reference within an embed (image, video, thumbnail). */
  EmbedMedia: {
    u: "string",
    "d?": "string",
    "w?": "number",
    "h?": "number",
    "m?": "string",
  },

  LinkEmbed: {
    url: "string",
    "embed?": "LinkEmbedData",
  },

  /**
   * A reply: the message this one answers.
   *
   * `messageId` is the target's id and nothing else — the target's body is
   * not denormalised here (a reply renders as a context line that fetches on
   * demand), so this is the one attachment variant that carries no `message`.
   */
  AttachmentReply: {
    $type: "'space.roomy.attachment.reply.v0'",
    messageId: "string",
  },

  /**
   * A forward: another message rendered as an embed inside this one.
   *
   * `messageId`/`roomId`/`name` locate the original; `message` is that
   * original fully denormalised (its own `forwardedFrom` chain included for
   * nested forwards) so a client renders it with no extra fetch. Absent when
   * the original couldn't be resolved (deleted, not-yet-materialised, or
   * cross-space).
   */
  AttachmentForward: {
    $type: "'space.roomy.attachment.forward.v0'",
    messageId: "string",
    roomId: "string",
    name: "string",
    "message?": "Message",
  },

  AttachmentImage: {
    $type: "'space.roomy.attachment.image.v0'",
    url: "string",
    /** MIME type of the attachment blob. */
    type: "string",
    "alt?": "string",
    "width?": "number",
    "height?": "number",
    "blurhash?": "string",
    "size?": "number",
  },

  AttachmentVideo: {
    $type: "'space.roomy.attachment.video.v0'",
    url: "string",
    /** MIME type of the attachment blob. */
    type: "string",
    "alt?": "string",
    "width?": "number",
    "height?": "number",
    /** Duration in seconds. */
    "length?": "number",
    "blurhash?": "string",
    "size?": "number",
  },

  AttachmentFile: {
    $type: "'space.roomy.attachment.file.v0'",
    url: "string",
    /** MIME type of the attachment blob. */
    type: "string",
    "name?": "string",
    "size?": "number",
  },

  /**
   * A link, with its enriched preview when the enricher has reached it.
   *
   * A link is the one kind that also appears in the derived `linkEmbeds` and,
   * as a `text/uri-list` row, in the derived `media` — where the media
   * renderers have always received it and filter it out by MIME type. Only
   * links the author left showing reach the client at all: the projection
   * drops `show_preview = 0` rows, so a dismissed preview is indistinguishable
   * from never having had one.
   */
  AttachmentLink: {
    $type: "'space.roomy.attachment.link.v0'",
    url: "string",
    /** Enriched embed data (EmbedV1 JSON), absent when enrichment hasn't completed or had no data. */
    "embed?": "LinkEmbedData",
  },

  /**
   * One entry per attachment on a message, discriminated by `$type`.
   *
   * The kind set is the read path's, not the write path's: the materialiser
   * also stores `space.roomy.attachment.comment.v0` into `comp_comment`, but
   * no query in the tree reads that table, so a comment never reaches a client
   * and has no variant here.
   */
  AttachmentDto: "AttachmentReply | AttachmentForward | AttachmentImage | AttachmentVideo | AttachmentFile | AttachmentLink",

  Message: {
    id: "string",
    /** Sort index for timeline ordering. ULID based on canonical timestamp. */
    "sort_idx?": "string",
    content: "string",
    /**
     * MIME type of the content blob. `text/markdown` for legacy messages,
     * `application/vnd.roomy.richtext+json` for blocks+facets messages.
     * Clients branch rendering on this.
     */
    "mimeType?": "string",
    authorDid: "string",
    authorName: "string",
    "authorHandle?": "string",
    "authorAvatar?": "string",
    /**
     * True for system messages (e.g. "X joined the space", "X created
     * [thread]") — authored by the space itself. The author line is not
     * meaningful for these; clients should hide the author identity.
     */
    "system?": "boolean",
    /**
     * The message's author is hidden from the viewer by a block, in either
     * direction: the viewer blocked the author, or the author blocked the
     * viewer. The server redacts such a row to a tombstone — identity and
     * ordering kept, body and attachments gone — so this flag is what tells
     * that row apart from a genuinely empty message.
     */
    "blocked?": "boolean",
    timestamp: "string",
    /**
     * Present only when the message has been edited: the ULID of the most
     * recent edit event. Absent for a message that has never been edited
     * (the materialiser stamps the creating event's own id into
     * `comp_content.last_edit`, so an unedited message is `last_edit ==
     * id`). The value is the edit EVENT id, not a timestamp — clients only
     * need its presence to render an "edited" affordance.
     */
    "lastEdit?": "string",
    /**
     * Every attachment on the message, one entry per row, each discriminated
     * by `$type`. This is the shape a new attachment kind lands in: its
     * renderer switches on `$type` instead of being handed a fifth parallel
     * field. Renderers being migrated read the derived fields below until
     * they move over.
     */
    attachments: "AttachmentDto[]",
    /**
     * Derived view of `attachments` for the reply context line: the id of the
     * message being replied to. Present only when the message carries a reply
     * attachment.
     */
    "replyTo?": "string",
    /** Derived view of `attachments` for the forward embed. See `AttachmentForward`. */
    "forwardedFrom?": "ForwardedFrom",
    reactions: "Reaction[]",
    /**
     * Derived view of `attachments`: the image, video and file rows plus the
     * link rows as `text/uri-list` entries, in that kind order. That last part
     * is deliberate — the media renderers have always received links here and
     * filter them out by MIME type.
     */
    media: "Media[]",
    /** Derived view of `attachments`: the link rows, with enriched metadata. */
    linkEmbeds: "LinkEmbed[]",
  },
}).export();

export const Reaction = Schemas.Reaction;
export const Media = Schemas.Media;
export const ForwardedFrom = Schemas.ForwardedFrom;
export const LinkEmbedData = Schemas.LinkEmbedData;
export const LinkEmbed = Schemas.LinkEmbed;
export const AttachmentReply = Schemas.AttachmentReply;
export const AttachmentForward = Schemas.AttachmentForward;
export const AttachmentImage = Schemas.AttachmentImage;
export const AttachmentVideo = Schemas.AttachmentVideo;
export const AttachmentFile = Schemas.AttachmentFile;
export const AttachmentLink = Schemas.AttachmentLink;
export const AttachmentDto = Schemas.AttachmentDto;
export const Message = Schemas.Message;
