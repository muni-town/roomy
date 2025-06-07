export function extractLinks(htmlString: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const anchors = doc.querySelectorAll("a");
  return Array.from(anchors, (a) => a.getAttribute("href")).filter(
    (a) => a !== null,
  );
}
