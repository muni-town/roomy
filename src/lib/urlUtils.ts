import { linkify } from "$lib/linkify";

/**
 * Converts plain text URLs in a string to HTML anchor tags,
 * but preserves existing HTML tags (does not linkify inside tags).
 * @param html - The HTML content containing URLs to convert
 * @returns The HTML with plain text URLs converted to clickable links
 */
export function convertUrlsToLinks(html: string): string {
  // Regex to split by HTML tags, capturing tags as separate parts
  const parts = html.split(/(<[^>]+>)/g);

  // Process only text parts (even indices), leave tags (odd indices) untouched
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (!text) continue;

    const matches = linkify.match(text);
    if (matches) {
      const result = [];
      let last = 0;
      matches.forEach((match) => {
        if (last < match.index) {
          result.push(text.slice(last, match.index).replace(/\r?\n/g, "<br>"));
        }
        result.push('<a target="_blank" href="');
        result.push(match.url);
        result.push('">');
        result.push(match.text);
        result.push("</a>");
        last = match.lastIndex;
      });
      if (last < text.length) {
        result.push(text.slice(last).replace(/\r?\n/g, "<br>"));
      }
      parts[i] = result.join("");
    } else {
      // Replace newlines with <br> even if no URLs found
      parts[i] = text.replace(/\r?\n/g, "<br>");
    }
  }

  return parts.join("");
}
