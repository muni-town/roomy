import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render the markdown string to sanitized HTML, ready for display in the app. */
export function renderMarkdownSanitized(markdown: string) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false })) as string;
}

export function renderMarkdownPlaintext(markdown: string): string {
  const html = DOMPurify.sanitize(
    marked.parse(markdown, { async: false }),
  ) as string;

  // Use the browser’s HTML parser rather than regex
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}
