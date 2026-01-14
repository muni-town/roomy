import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${title}"` : "";

      // open external links in a new tab with security attributes
      const isExternal = href?.startsWith("http");
      const targetAttr = isExternal
        ? ' target="_blank" rel="noopener noreferrer"'
        : "";
      return `<a href="${href}"${titleAttr}${targetAttr}>${text}</a>`;
    },
  },
});

/** Render the markdown string to sanitized HTML, ready for display in the app. */
export function renderMarkdownSanitized(markdown: string) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    ADD_ATTR: ["target", "rel"],
  }) as string;
}

export function renderMarkdownPlaintext(markdown: string): string {
  const html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    ADD_ATTR: ["target", "rel"],
  }) as string;

  // Use the browser’s HTML parser rather than regex
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}
