import type { Editor } from "@tiptap/core";

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
