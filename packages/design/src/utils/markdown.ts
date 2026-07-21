import { marked } from "marked";
import DOMPurify from "dompurify";

// Known Roomy domains — bare links to these are treated as internal space/room
// references and replaced with rich badge components.
const ROOMY_DOMAINS = new Set(["roomy.space", "a.roomy.space", "roomy.chat"]);

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

      // Mark internal links (starting with /) so the client can replace them
      // with rich badge components for space/room references.
      const isInternalLink = !isExternal && href?.startsWith("/");
      const internalAttr = isInternalLink ? ' data-roomy-internal-link="true"' : "";

      // Also mark bare links to known Roomy domains (roomy.space, roomy.chat)
      // so they get the same badge treatment.
      let roomyDomainAttr = "";
      if (isExternal && href) {
        try {
          const url = new URL(href);
          if (ROOMY_DOMAINS.has(url.hostname)) {
            roomyDomainAttr = ' data-roomy-internal-link="true"';
          }
        } catch {
          // ignore invalid URLs
        }
      }

      return `<a href="${href}"${titleAttr}${targetAttr}${internalAttr}${roomyDomainAttr}>${text}</a>`;
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
      ADD_ATTR: ["target", "rel", "data-roomy-internal-link"],
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

/**
 * Render inline markdown (no block-level wrapping like <p>) for use inside
 * Svelte templates where block elements would break layout.
 */
export function renderInlineMarkdown(markdown: string): string {
  if (!markdown) return "";
  return cachedGet(htmlCache, `inline:${markdown}`, () =>
    DOMPurify.sanitize(marked.parseInline(markdown, { async: false }), {
      ADD_ATTR: ["target", "rel"],
    }) as string,
  );
}
