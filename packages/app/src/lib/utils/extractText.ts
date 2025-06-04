// Helper function to extract text content from TipTap JSON content
export function extractTextContent(
  parsedBody: Record<string, unknown>,
): string {
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    !("content" in parsedBody)
  )
    return "";

  let text = "";

  // Process the content recursively to extract text
  function processNode(node: Record<string, unknown>): void {
    if ("text" in node && typeof node.text === "string") {
      text = `${text}${node.text} `;
    }

    if ("content" in node && Array.isArray(node.content)) {
      for (const item of node.content) {
        if (typeof item === "object" && item !== null) {
          processNode(item as Record<string, unknown>);
        }
      }
    }
  }

  // Start processing from the root content
  if ("content" in parsedBody && Array.isArray(parsedBody.content)) {
    for (const node of parsedBody.content) {
      if (typeof node === "object" && node !== null) {
        processNode(node as Record<string, unknown>);
      }
    }
  }

  return text.trim();
}
