/**
 * The document a link-unfurling crawler gets for an invite link.
 *
 * The app is a static SPA: `roomy.space/join?...` is the same shell for every
 * space, and a crawler never runs the bundle that would fill in the head (see
 * the comment in `packages/app-lite/src/app.html`). So the app host's Caddy
 * hands a crawler's request for `/join` to the appserver instead (`Caddyfile`),
 * and this is what it answers with: a head naming the space, its invite card as
 * the image, and a body with a link a person can follow if a browser ever
 * lands here.
 *
 * Pure: the route resolves the space and passes what it found.
 */

import { OG_HEIGHT, OG_WIDTH } from "./render.ts";

/** The site-wide card, for a link whose space cannot be found. */
export const SITE_OG_IMAGE = "https://roomy.space/roomy-og.png";
const SITE_TITLE = "Roomy";
const SITE_DESCRIPTION = "Cozy community spaces; cultivate your digital gardens.";
const SITE_IMAGE_ALT = "Roomy — your community needs its own space";

/** Escape text for an HTML attribute value or text node. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapse whitespace and cut to `max` code points with an ellipsis. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export interface InvitePage {
  /** Where a person who lands here should go: the join link, as the app serves it. */
  appHref: string;
  /** The space, when the link names one that exists. */
  space?: {
    name: string;
    description?: string;
    /** Absolute URL of the space's invite card. */
    imageUrl: string;
  };
}

/** The invite page's HTML. */
export function renderInvitePage(page: InvitePage): string {
  const { space } = page;
  const title = space ? `Join ${clip(space.name, 80)} on Roomy` : SITE_TITLE;
  const description = space
    ? clip(space.description || `You're invited to join ${space.name} on Roomy.`, 200)
    : SITE_DESCRIPTION;
  const image = space?.imageUrl ?? SITE_OG_IMAGE;
  const imageAlt = space ? `Invitation to join ${clip(space.name, 80)} on Roomy` : SITE_IMAGE_ALT;

  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${e(title)}</title>
    <meta name="description" content="${e(description)}" />
    <meta property="og:site_name" content="Roomy" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${e(title)}" />
    <meta property="og:description" content="${e(description)}" />
    <meta property="og:image" content="${e(image)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="${OG_WIDTH}" />
    <meta property="og:image:height" content="${OG_HEIGHT}" />
    <meta property="og:image:alt" content="${e(imageAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${e(title)}" />
    <meta name="twitter:description" content="${e(description)}" />
    <meta name="twitter:image" content="${e(image)}" />
    <meta name="twitter:image:alt" content="${e(imageAlt)}" />
    <meta name="robots" content="noindex" />
  </head>
  <body>
    <h1>${e(title)}</h1>
    <p>${e(description)}</p>
    <p><a href="${e(page.appHref)}">Open in Roomy</a></p>
  </body>
</html>
`;
}
