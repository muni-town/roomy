/**
 * A Bluesky post, rendered from the payload the host hands over.
 *
 * The tile fetches nothing itself: everything it draws arrives as `data.post`
 * over the tiles data-passing protocol. The host resolved the record
 * server-side, so no viewer's link-following leaves this frame.
 *
 * Media is drawn from the URLs the AppView put in the payload (`cdn.bsky.app`
 * thumbnails and avatars), each marked `no-referrer`. Whether those URLs
 * resolve is the loading server's call: the shuttle's service worker answers
 * every request the frame makes, asking the host to resolve the path, so an
 * image paints only when the host recognises the path it asked for. The card
 * is laid out so a picture that does not arrive leaves the text intact.
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

/**
 * The path the host is asked for an image at.
 *
 * A tile's frame cannot reach the image host: the loading server's worker
 * answers every request the frame makes — off-origin ones included — by
 * resolving the path with the host, so a bare `cdn.bsky.app` URL is a request
 * the host is never told about. The URL therefore travels in the path, and the
 * host answers it with the image's bytes or declines and leaves the picture
 * out.
 */
const IMAGE_PATH = "/image/";

/** Where to ask for an image the payload named by URL. */
function imageSource(url) {
  return /^https?:\/\//.test(url) ? IMAGE_PATH + encodeURIComponent(url) : url;
}

/**
 * An image the tile draws, or null when the payload has no usable URL.
 *
 * `alt` is the record's own alt text, so a screen reader hears what the post
 * said about the image rather than a filename. `no-referrer` keeps the frame's
 * per-tile origin out of the image host's logs, and a thumbnail that fails to
 * load removes itself rather than leaving a broken frame in the layout.
 */
function image(src, alt, className) {
  if (typeof src !== "string" || src.length === 0) return null;
  const img = document.createElement("img");
  img.className = className;
  img.src = imageSource(src);
  img.alt = typeof alt === "string" ? alt : "";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => img.remove());
  return img;
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

/**
 * An image embed: one picture across the card, or a compact grid of up to four.
 *
 * A single image carries its alt text below it, because a post that described
 * its picture is worth more than the picture alone. In a grid the alts would
 * not fit, so the images speak for themselves.
 */
function imageGrid(images, className) {
  const usable = (Array.isArray(images) ? images : []).filter(
    (img) => img && typeof img.thumb === "string" && img.thumb.length > 0,
  );
  if (usable.length === 0) return null;
  const shown = usable.slice(0, 4);
  const grid = el("div", `${className} n${shown.length}`);
  for (const img of shown) {
    const node = image(img.thumb, img.alt, "shot");
    if (node) grid.append(node);
  }
  if (grid.childElementCount === 0) return null;
  if (shown.length === 1 && shown[0].alt) grid.append(el("span", "alt", shown[0].alt));
  return grid;
}

/** A link card: its thumbnail, title and description. */
function externalCard(external) {
  const card = el("div", "external");
  const thumb = image(external.thumb, "", "thumb");
  if (thumb) card.append(thumb);
  const body = el("div", "body");
  body.append(el("strong", "title", external.title || external.uri || "Link"));
  if (external.description) body.append(el("span", "muted", external.description));
  card.append(body);
  return card;
}

/**
 * A quoted post: its author, text and, when the quoted post has one, its own
 * first embed — an image or a link, one level deep.
 */
function quoteCard(quote) {
  const box = el("div", "quote");
  const author = quote.author ?? {};
  const who = el("div", "who");
  const avatar = image(author.avatar, "", "avatar small");
  if (avatar) who.append(avatar);
  who.append(el("span", "name", author.displayName || `@${author.handle ?? "unknown"}`));
  if (author.displayName && author.handle) {
    who.append(el("span", "handle", `@${author.handle}`));
  }
  box.append(who);
  if (quote.text) box.append(el("p", "text", quote.text));

  const media = quote.media;
  if (media && media.kind === "image") {
    const grid = imageGrid(media.images, "images quoted");
    if (grid) box.append(grid);
  } else if (media && media.kind === "external") {
    box.append(externalCard(media));
  }
  return box;
}

/** The card for an external link, quoted post, image set or video. */
function attachedView(post) {
  const embed = post.embed;
  if (!embed || typeof embed !== "object") return null;
  switch (embed.kind) {
    case "external":
      return externalCard(embed);
    case "quote":
      return quoteCard(embed);
    case "image":
      return imageGrid(embed.images, "images");
    case "video":
      // Playing video stays out of this tile: a thumbnail with the record's
      // alt text says there is a clip without claiming to run one.
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
  const avatar = image(author.avatar, "", "avatar");
  if (avatar) who.append(avatar);
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
