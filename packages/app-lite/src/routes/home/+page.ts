import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * `/home` is the feed, which is `/`.
 *
 * A PWA keeps the manifest it was installed with, so a home-screen icon
 * installed while `manifest.json` declared `start_url: "/home"` still opens
 * that path after the manifest changed. `/home` is also the one non-DID first
 * path segment a real client asks for, so without a route of its own it
 * matches `/[space]` and the DID guard answers `404 No space at "home"`.
 * Redirecting here removes the segment from that guard's input instead of
 * widening the guard, and covers a plain bookmark the same way.
 */
export const prerender = true;

export const load: PageLoad = () => {
  throw redirect(307, "/");
};
