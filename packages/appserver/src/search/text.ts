/**
 * Plaintext extraction for the Qdrant message index.
 *
 * The search indexer indexes the decoded plaintext of every message — never
 * the raw blob. Rich-text bodies (`application/vnd.roomy.richtext+json`)
 * decode to blocks; legacy text/* bodies decode to strings with markdown/HTML
 * stripped. Messages with no indexable text (null data, unparseable richtext,
 * non-text mime) yield "" and are skipped by the indexer.
 *
 * Both the Qdrant index and the FTS index must see the same text, so the
 * extraction rules here are shared.
 */

import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { stripMarkdownToPlaintext } from "../push/plaintext.ts";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";

/**
 * Extract the plaintext to index for a message content blob.
 *
 * - Rich text (`application/vnd.roomy.richtext+json`): decode the blocks and
 *   concatenate their text via `blocksToPlaintext`.
 * - Legacy text/* : decode the string and strip markdown/HTML.
 * - Anything else / unparseable: empty string (nothing to index).
 */
export function extractMessageText(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (data === null) return "";
  if (mime === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(mime, data);
    if (blocks) return blocksToPlaintext(blocks);
    return "";
  }
  if (!mime || mime.startsWith("text/") || mime === "application/json") {
    return stripMarkdownToPlaintext(decodeContent(mime, data));
  }
  return "";
}
