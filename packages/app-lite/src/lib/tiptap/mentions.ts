import type { Editor } from "@tiptap/core";
import { cache } from "@roomy-space/sdk";
import { queryClient } from "$lib/client";
import { auth, px } from "$lib/auth.svelte";
import { resolveBlobUrl } from "$lib/utils";
import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
import type { Message } from "$lib/queries/messages";
import type { Member, ExternalAdmin } from "$lib/queries/members";

/**
 * Extract the set of user DIDs mentioned in the editor's ProseMirror document.
 *
 * Walks the doc tree for `userMention` nodes (the `@user` extension) and collects
 * their `attrs.id` (the user's DID). De-duplicates — each mentioned user produces
 * one entry regardless of how many times they're mentioned in the message.
 *
 * Channel/thread `#room` mentions use a different node name (`channelThreadMention`)
 * and are intentionally excluded — they are not user mentions.
 */
export function extractMentionDids(editor: Editor): string[] {
  const dids = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "userMention") {
      const did = node.attrs.id;
      if (typeof did === "string" && did.startsWith("did:")) {
        dids.add(did);
      }
    }
    return true; // descend into children
  });
  return [...dids];
}

/**
 * Build the server-search fetcher for `@user` mentions in a chat input —
 * shared by the composer, the edit-message editor, and the forward composer.
 *
 * Empty query → the most-recently-active members in the room, derived from
 * the cached `getMessages` result (no extra fetch), ordered by last activity
 * with the most recent last. Non-empty → `getMembers?search=` on the
 * appserver, including both members and external admins so space admins
 * without membership are mentionable too. (Self-exclusion applies only to
 * the preseed, not to search results.)
 */
export function createMentionSearch(
  spaceId: string,
  roomId: string,
): (query: string) => Promise<TypeaheadUser[]> {
  function recentActiveMembers(): TypeaheadUser[] {
    const msgs = queryClient.getQueryData<Message[]>(
      cache.queryKey("space.roomy.room.getMessages", { roomId }),
    );
    if (!msgs || msgs.length === 0) return [];
    const selfDid = auth.userDid;
    // Track each author's most recent message; `sort_idx` (ULID) is the
    // canonical timeline order, falling back to the ISO `timestamp`.
    const lastByDid = new Map<string, { user: TypeaheadUser; last: string }>();
    for (const m of msgs) {
      if (m.authorDid === selfDid) continue;
      const ord = m.sort_idx ?? m.timestamp;
      const existing = lastByDid.get(m.authorDid);
      if (!existing || ord > existing.last) {
        lastByDid.set(m.authorDid, {
          user: {
            did: m.authorDid,
            name: m.authorName,
            handle: m.authorHandle,
            avatar: resolveBlobUrl(m.authorAvatar),
          },
          last: ord,
        });
      }
    }
    return [...lastByDid.values()]
      .sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0))
      .map((v) => v.user)
      .slice(-8); // cap to the 8 most-recently-active; most recent stays last
  }

  return async (q: string): Promise<TypeaheadUser[]> => {
    const query = q.trim();
    if (query === "") return recentActiveMembers();
    const res = (await px().query("space.roomy.space.getMembers", {
      spaceId,
      search: query,
    })) as { members: Member[]; externalAdmins: ExternalAdmin[] };
    return [...res.members, ...res.externalAdmins].map((m) => ({
      did: m.did,
      handle: m.handle,
      name: m.name,
      avatar: resolveBlobUrl(m.avatar),
    }));
  };
}
