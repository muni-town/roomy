/**
 * A Bluesky post, rendered from the payload the host hands over.
 *
 * The tile fetches nothing. Everything it draws arrives as `data.post` over the
 * tiles data-passing protocol: the host resolved the record server-side, so no
 * viewer's link-following leaves this frame, and the loading server's CSP
 * (which admits no off-origin source) is never in the way. Images referenced by
 * the post cannot be drawn for that same reason; the card is typography.
 *
 * The protocol module is loaded from its reserved path and may be absent — an
 * environment that does not implement data passing simply draws the empty
 * state, which is what the spec asks a tile to do rather than assume its host.
 */

const root = document.getElementById("post");

/** Element factory: text always through `textContent`, never markup. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short, human date for the post's timestamp. */
function formatWhen(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const minutes = Math.round((now - date.getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The card for an external link or quoted post, when the post carries one. */
function attachedView(post) {
  const embed = post.embed;
  if (!embed || typeof embed !== "object") return null;
  switch (embed.kind) {
    case "external":
      return el(
        "div",
        "attached",
        embed.title || embed.description || embed.uri,
      );
    case "quote": {
      const box = el("div", "attached");
      box.append(el("strong", "", `@${embed.author?.handle ?? "unknown"}`));
      if (embed.text) box.append(document.createTextNode(` — ${embed.text}`));
      return box;
    }
    case "image": {
      const count = Array.isArray(embed.images) ? embed.images.length : 0;
      if (count === 0) return null;
      const alt = embed.images.map((image) => image.alt).find(Boolean);
      return el(
        "div",
        "attached",
        alt ? `Image: ${alt}` : `${count} image${count === 1 ? "" : "s"}`,
      );
    }
    case "video":
      return el("div", "attached", embed.alt ? `Video: ${embed.alt}` : "Video");
    default:
      return null;
  }
}

/** Draw one post, or say why there is nothing to draw. */
function render(data) {
  if (!root) return;
  const post = data && typeof data === "object" ? data.post : undefined;
  if (!post || typeof post !== "object") {
    root.replaceChildren(el("p", "empty", "No post to show."));
    return;
  }

  const author = post.author ?? {};
  const who = el("div", "who");
  who.append(el("span", "name", author.displayName || `@${author.handle}`));
  if (author.displayName && author.handle) {
    who.append(el("span", "handle", `@${author.handle}`));
  }
  const when = formatWhen(post.createdAt);
  if (when) who.append(el("span", "when", `· ${when}`));

  const nodes = [who];
  if (post.text) nodes.push(el("p", "text", post.text));

  const attached = attachedView(post);
  if (attached) nodes.push(attached);

  const counts = post.counts ?? {};
  const footer = el("footer");
  for (const [label, value] of [
    ["replies", counts.reply],
    ["reposts", counts.repost],
    ["likes", counts.like],
  ]) {
    if (typeof value !== "number" || value <= 0) continue;
    footer.append(el("span", "", `${value.toLocaleString()} ${label}`));
  }
  if (footer.childElementCount > 0) nodes.push(footer);

  root.replaceChildren(...nodes);
}

try {
  const dataProtocol = await import("/.well-known/web-tiles/data.js");
  dataProtocol.addDataHandler(render);
  // `listen()` is the tile saying its handlers exist. The host also sends the
  // payload on the loader's own `load` event, before this point, which is why
  // the empty state above is drawn rather than left blank.
  dataProtocol.listen();
} catch {
  // No data passing in this environment: the empty state is the honest render.
}
