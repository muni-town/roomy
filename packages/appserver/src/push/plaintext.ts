/**
 * Strip markdown (including inline HTML) to plain text for push notification
 * bodies. The appserver doesn't have `marked`/`DOMPurify` in its dependency
 * tree, so this is a lightweight regex-based stripper that handles the common
 * patterns produced by the Roomy message composer.
 *
 * Order matters: HTML is stripped first (it may contain markdown-like text),
 * then markdown syntax, then whitespace is collapsed.
 */

/**
 * Strip markdown + HTML to plain text.
 *
 * - Removes HTML tags (including self-closing and void elements).
 * - Removes markdown formatting: bold, italic, strikethrough, inline code,
 *   code fences, blockquotes, headings, horizontal rules, images, links
 *   (keeps link text), and list markers.
 * - Collapses runs of whitespace into single spaces.
 * - Trims leading/trailing whitespace.
 */
export function stripMarkdownToPlaintext(input: string): string {
  let text = input;

  // Strip HTML tags. Loop until stable to handle `>` inside attribute values
  // (e.g. `<img src=">" onerror="alert(1)">` — first pass matches `<img src=">"`,
  // leaving ` onerror="alert(1)">` which is still a live tag).
  let previousText: string;
  do {
    previousText = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previousText);

  // 2. Strip markdown images: ![alt](url) → keep alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 3. Strip markdown links: [text](url) → keep text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 4. Strip inline code backticks (`` `code` `` and `` ` ``)
  text = text.replace(/`{1,3}[^`]*`{1,3}/g, (match) => {
    // Remove the backticks, keep the content
    return match.replace(/`/g, "");
  });

  // 5. Strip code fences (```lang\n...\n``` or ~~~)
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/~~~[\s\S]*?~~~/g, "");

  // 6. Strip bold/italic/strikethrough markers
  //    **bold** or __bold__
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  //    *italic* or _italic_
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  //    ~~strikethrough~~
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // 7. Strip blockquote markers ("> " at line start, including nested)
  text = text.replace(/^>+\s*/gm, "");

  // 8. Strip heading markers (# at line start)
  text = text.replace(/^#{1,6}\s+/gm, "");

  // 9. Strip horizontal rules (---, ***, ___ on their own line)
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");

  // 10. Strip list markers (-, *, +, 1. at line start)
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // 11. Collapse runs of whitespace (newlines, tabs, multiple spaces) into one space
  text = text.replace(/\s+/g, " ");

  // 12. Trim
  text = text.trim();

  return text;
}
