import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
/** Render the markdown string to sanitized HTML, ready for display in the app. */
export function renderMarkdownSanitized(markdown: string): string {
  return sanitizeHtml(
    (marked.parse(markdown) as string).replace("<a ", '<a target="_blank" '),
  );
}
