import linkifyit from "linkify-it";
const linkify = new linkifyit();

/**
 * Converts plain text URLs in a string to HTML anchor tags
 * @param html - The HTML content containing URLs to convert
 * @returns The HTML with plain text URLs converted to clickable links
 */
export function convertUrlsToLinks(html: string): string {
  const matches = linkify.match(html);

  if (matches) {
    const result = [];
    let last = 0;
    matches.forEach(function (match) {
      if (last < match.index) {
        result.push(html.slice(last, match.index).replace(/\r?\n/g, "<br>"));
      }
      result.push('<a target="_blank" href="');
      result.push(match.url);
      result.push('">');
      result.push(match.text);
      result.push("</a>");
      last = match.lastIndex;
    });
    if (last < html.length) {
      result.push(html.slice(last).replace(/\r?\n/g, "<br>"));
    }
    return result.join("");
  }
  return html;
}
