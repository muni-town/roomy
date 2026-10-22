/**
 * The one place a rendered message switches on an attachment's `$type`.
 *
 * A message carries `attachments: AttachmentDto[]` — one entry per
 * attachment, each discriminated by `$type`. Every surface that draws a
 * message's attachments (the chat bubble, search results, the activity feed)
 * reads that list through this module rather than filtering it itself: a new
 * attachment kind gets one arm here, in one switch, instead of a new field on
 * the message DTO and a new branch at every call site.
 *
 * The two functions return the shapes the existing renderers already take —
 * `MediaEmbed`'s list and `LinkCard`'s per-entry fields — so the split between
 * `media` and `linkEmbeds` lives here, once, rather than in each template.
 *
 * The MIME-type filter the media renderer used to do is not reproduced: it
 * existed because a link reached `media` as a `text/uri-list` row and would
 * otherwise be drawn twice (`MediaEmbed` has no link arm). Selecting by
 * `$type` says the same thing directly.
 */
import type { schemas } from "@roomy-space/sdk";
import type { Message } from "$lib/queries/messages";

type Attachment = Message["attachments"][number];
type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

/** An entry `MediaEmbed` renders: an image, a video or a file. */
export type MediaItem = {
  url: string;
  /** MIME type of the blob, which is what picks the arm inside `MediaEmbed`. */
  type: string;
  alt?: string;
};

/** An entry `LinkCard` renders. */
export type LinkItem = {
  url: string;
  embed?: LinkEmbedData;
};

/**
 * The image, video and file entries of an attachment list, in the order the
 * message carries them.
 */
export function mediaItems(attachments: readonly Attachment[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const a of attachments) {
    switch (a.$type) {
      case "space.roomy.attachment.image.v0":
      case "space.roomy.attachment.video.v0":
        out.push({ url: a.url, type: a.type, ...(a.alt != null ? { alt: a.alt } : {}) });
        break;
      case "space.roomy.attachment.file.v0":
        // `MediaEmbed`'s file arm renders a fixed "Download file" label off
        // `alt`, which the projection never set for a file — it carries the
        // name in `name` instead. Passing the name as `alt` here would start
        // showing it, a change this step does not make.
        out.push({ url: a.url, type: a.type });
        break;
      default:
        break;
    }
  }
  return out;
}

/** The link entries of an attachment list, in the order the message carries them. */
export function linkItems(attachments: readonly Attachment[]): LinkItem[] {
  const out: LinkItem[] = [];
  for (const a of attachments) {
    if (a.$type !== "space.roomy.attachment.link.v0") continue;
    out.push({
      url: a.url,
      ...(a.embed != null ? { embed: a.embed as LinkEmbedData } : {}),
    });
  }
  return out;
}
