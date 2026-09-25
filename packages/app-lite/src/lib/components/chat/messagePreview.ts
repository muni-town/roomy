import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";
import { renderMarkdownPlaintext } from "@roomy/design/utils";
import { parseRichTextContent } from "./message-body";

/**
 * Render a message body as plaintext for compact previews (reply context,
 * thread context, …).
 *
 * Legacy messages carry markdown in `content`; rich-text messages carry the
 * **base64-encoded** blocks document (see `decodeContent` in the appserver),
 * so they must be base64-decoded → JSON.parse → blocks before their text can
 * be shown. Passing the raw encoded string to the markdown renderer would
 * surface the encoded byte string instead of the decoded message.
 */
export function messageContentToPlaintext(
  content: string,
  mimeType?: string,
): string {
  if (mimeType === RICHTEXT_MIME) {
    const blocks = parseRichTextContent(content);
    return blocks ? blocksToPlaintext(blocks) : "";
  }
  return renderMarkdownPlaintext(content);
}
