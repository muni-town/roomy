/**
 * Avatar resolution for push payloads.
 *
 * Avatars are materialised into `comp_info.avatar` as either a plain `https://`
 * URL or an `atblob://<did>/<cid>` ref. The browser/OS fetches a notification
 * `icon` image itself (it is NOT carried in the encrypted push bytes), so the
 * appserver must resolve `atblob://` to a public CDN URL — the browser can't
 * resolve `atblob://`. We mirror `app-lite`'s `resolveBlobUrl` exactly
 * (`atblob://<did>/<cid>` → `https://cdn.bsky.app/img/feed_fullsize/plain/…`)
 * so the icon a user sees on a notification matches the avatar they see in-app.
 *
 * For blobs not on Bluesky's CDN (e.g. a Roomy-native PDS) the URL may not
 * resolve; the browser then simply shows the notification with no icon —
 * progressive enhancement, same failure mode as in-app avatars.
 */

import type { Database } from "bun:sqlite";

/**
 * Resolve a stored avatar ref (`atblob://…` or a plain URL) to a
 * browser-fetchable image URL, or `undefined` if there is none / it is
 * unresolvable. Mirrors `app-lite/src/lib/utils.ts` `resolveBlobUrl`.
 */
export function resolveAvatarUrl(
  ref: string | null | undefined,
): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("atblob://")) {
    const rest = ref.slice("atblob://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    const did = rest.slice(0, slash);
    const cid = rest.slice(slash + 1);
    if (!did || !cid) return undefined;
    return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
  }
  return ref;
}

/**
 * Look up an entity's avatar from `comp_info` and resolve it to a public URL.
 * Returns `undefined` when the entity has no avatar or the ref is unresolvable.
 */
export function resolveEntityAvatar(
  db: Database,
  entity: string,
): string | undefined {
  const row = db
    .query<{ avatar: string | null }, [string]>(
      "select avatar from comp_info where entity = ?",
    )
    .get(entity);
  return resolveAvatarUrl(row?.avatar ?? null);
}

/**
 * Resolve the preferred notification icon: the sender's avatar, falling back
 * to the space's avatar (per the plan: "user avatars, or failing that, space
 * avatars"). Used for both `message` pushes (sender = the message author) and
 * `digest` pushes (sender = the room's most-recent author, via
 * {@link resolveLatestRoomAuthor}). Returns `undefined` when neither resolves.
 *
 * In practice user avatars are the reliable source: they're materialised as
 * pre-resolved `https://` CDN URLs that load, whereas space avatars are often
 * `atblob://` refs whose blobs aren't on Bluesky's CDN (404). So this order
 * surfaces a usable icon for the vast majority of notifications.
 */
export function resolveMessageIcon(
  db: Database,
  authorDid: string,
  spaceId: string,
): string | undefined {
  return resolveEntityAvatar(db, authorDid) ?? resolveEntityAvatar(db, spaceId);
}

/**
 * Find the DID of the most-recent message author in a room (the sender whose
 * avatar a time-based digest should show). Returns `null` when the room has no
 * messages. Used by the dispatcher digest sweep, which has no single job
 * author (unlike the on-event digest path, which knows the triggering author).
 */
export function resolveLatestRoomAuthor(
  db: Database,
  roomId: string,
): string | null {
  const row = db
    .query<{ author_did: string | null }, [string]>(
      `select author_e.tail as author_did
         from entities me
         join edges author_e
           on author_e.head = me.id and author_e.label = 'author'
         join comp_content cc on cc.entity = me.id
        where me.room = ?
        order by coalesce(me.sort_idx, me.id) desc
        limit 1`,
    )
    .get(roomId);
  return row?.author_did ?? null;
}