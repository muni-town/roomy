/**
 * Building shareable Roomy links.
 *
 * **Why links are not built from `location.origin`.** The desktop app is a
 * Tauri webview served from a custom scheme, so its document origin is
 * `tauri://localhost` — a link copied out of the desktop invite modal would
 * read `tauri://localhost/join?space=…`. A recipient can only open the public
 * web origin, so shareable links are rooted at the public web deployment.
 *
 * **How the desktop app is told apart from the web app.** The same static
 * bundle is both the web deployment and what the webview serves, so the
 * document cannot identify itself: `tauri://localhost` *and* `http://localhost`
 * (a build served locally) are both documents the app runs in, and neither is
 * shareable. The deployment marks itself instead — `PUBLIC_WEB_ORIGIN`, set to
 * the origin that build is served from, so a marker that matches the document
 * means the document *is* the public app. With no marker (the desktop bundle,
 * or a build nobody configured) the link points at the configured public web
 * origin.
 *
 * The rules here are pure — the document origin is passed in, never read — so
 * they are testable without a DOM or a build env. The live wiring
 * (`CONFIG.shareOrigin`) is in `config.ts`; the same split as `last-login.ts`.
 */

/**
 * Whether the document at `documentOrigin` is the public web deployment,
 * rather than a webview or a locally served copy of the same build.
 *
 * `marker` is `PUBLIC_WEB_ORIGIN`: present only in a web build, and equal to
 * the origin that build is served from.
 */
export function isPublicWebDocument(
  documentOrigin: string,
  marker: string | null,
): boolean {
  return marker !== null && marker === documentOrigin;
}

/**
 * The origin shareable links are rooted at.
 *
 * The configured public web origin normally; the document origin instead when
 * the document *is* the public web deployment, so a self-hosted or staging
 * deployment links to itself. A configured origin that cannot root a URL (a
 * value like `roomy.space`, with no scheme — env vars are not type-checked)
 * falls back to the document rather than throwing in a link builder.
 */
export function resolveShareOrigin(
  configuredOrigin: string | null,
  documentOrigin: string,
  marker: string | null,
): string {
  if (isPublicWebDocument(documentOrigin, marker)) return documentOrigin;
  if (!configuredOrigin) return documentOrigin;
  try {
    if (!new URL(configuredOrigin).protocol.startsWith("http")) {
      return documentOrigin;
    }
  } catch {
    return documentOrigin;
  }
  return configuredOrigin;
}

/**
 * `base` re-rooted at `origin`, keeping its path, query and fragment.
 *
 * The origin is substituted wholesale, so the document's scheme and host can
 * never reach the result. `base` may be a *relative* URL, in which case it is
 * resolved against `origin` first (SvelteKit's `page.url` is relative on
 * routes whose absolute URLs are hydrated after parse); only its path is kept
 * either way.
 */
export function shareUrl(origin: string, base: URL | string): URL {
  const target = typeof base === "string" ? new URL(base, origin) : base;
  return new URL(target.pathname + target.search + target.hash, origin);
}

/**
 * The invite link for `token` in `spaceId`, rooted at `origin`.
 *
 * Every invite surface (the sidebar's invite modal, the space settings →
 * invites page, the sidebar's copy-space-link) shares this one shape, so a
 * link cannot differ by the surface that produced it.
 */
export function inviteUrl(
  origin: string,
  spaceId: string,
  token: string,
): string {
  const url = new URL("/join", origin);
  url.searchParams.set("space", spaceId);
  url.searchParams.set("invite", token);
  return url.href;
}
