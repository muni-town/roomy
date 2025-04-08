/**
 * Regular expression for detecting URLs in text
 * This pattern matches common URL formats including:
 * - http:// and https:// URLs
 * - URLs without protocol but starting with www.
 * - URLs with common TLDs
 */
const URL_REGEX = /(https?:\/\/|www\.)[^\s<>"']+\.[^\s<>"']+(?=[\s<>"']|$)/gi;

/**
 * Converts plain text URLs in a string to HTML anchor tags
 * @param html - The HTML content containing URLs to convert
 * @returns The HTML with plain text URLs converted to clickable links
 */
export function convertUrlsToLinks(html: string): string {
  if (!html) return html;

  // Check if we're in a browser environment
  if (typeof document !== 'undefined') {
    return convertUrlsInBrowser(html);
  }

  // Fallback for server-side rendering
  return convertUrlsWithRegex(html);
}

/**
 * Browser implementation using DOM API
 */
function convertUrlsInBrowser(html: string): string {
  // Create a temporary DOM element to parse the HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Process all text nodes in the DOM
  const textNodes = getTextNodes(tempDiv);

  for (const node of textNodes) {
    const text = node.nodeValue;
    if (!text || !URL_REGEX.test(text)) continue;

    // Reset regex lastIndex
    URL_REGEX.lastIndex = 0;

    // Create a document fragment to hold the new nodes
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    // Find all URLs in the text node
    let match: RegExpExecArray | null = URL_REGEX.exec(text);
    while (match !== null) {
      const url = match[0];
      const matchIndex = match.index;

      // Add text before the URL
      if (matchIndex > lastIndex) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex, matchIndex)));
      }

      // Create an anchor element for the URL
      const anchor = document.createElement('a');
      anchor.href = url.startsWith('www.') ? `https://${url}` : url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = url;
      fragment.appendChild(anchor);

      lastIndex = matchIndex + url.length;

      // Get the next match
      match = URL_REGEX.exec(text);
    }

    // Add any remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    // Replace the original text node with the fragment
    if (lastIndex > 0 && node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  }

  return tempDiv.innerHTML;
}

/**
 * Server-side implementation using regex
 */
function convertUrlsWithRegex(html: string): string {
  // This is a simplified version that works for basic cases
  // It might not handle all edge cases perfectly
  return html.replace(URL_REGEX, (url) => {
    const href = url.startsWith('www.') ? `https://${url}` : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

/**
 * Gets all text nodes in a DOM element
 * @param node - The DOM node to search
 * @returns Array of text nodes
 */
function getTextNodes(node: Node): Text[] {
  const textNodes: Text[] = [];

  // Skip script and style elements
  if (node instanceof HTMLScriptElement || node instanceof HTMLStyleElement) {
    return textNodes;
  }

  // If this is a text node, add it to the result
  if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim() !== '') {
    textNodes.push(node as Text);
  }

  // Recursively process child nodes
  const childNodes = node.childNodes;
  for (let i = 0; i < childNodes.length; i++) {
    const childNode = childNodes[i];
    if (childNode) {
      textNodes.push(...getTextNodes(childNode));
    }
  }

  return textNodes;
}
