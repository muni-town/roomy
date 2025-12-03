import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render the markdown string to sanitized HTML, ready for display in the app. */
export function renderMarkdownSanitized(markdown: string) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false })) as string;
}
