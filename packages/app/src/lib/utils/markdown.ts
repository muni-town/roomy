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

// LRU-style cache for rendered markdown to avoid re-parsing on every scroll
const htmlCache = new Map<string, string>();
const plaintextCache = new Map<string, string>();
const MAX_CACHE = 500;

function cachedGet(cache: Map<string, string>, key: string, compute: () => string): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = compute();
  if (cache.size >= MAX_CACHE) {
    // Delete oldest entry
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, result);
  return result;
}

/** Render the markdown string to sanitized HTML, ready for display in the app. */
export function renderMarkdownSanitized(markdown: string) {
  return cachedGet(htmlCache, markdown, () =>
    DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
      ADD_ATTR: ["target", "rel"],
    }) as string,
  );
}

export function renderMarkdownPlaintext(markdown: string): string {
  return cachedGet(plaintextCache, markdown, () => {
    const html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
      ADD_ATTR: ["target", "rel"],
    }) as string;
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent ?? "";
  });
}
