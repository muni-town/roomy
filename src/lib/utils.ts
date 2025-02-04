import type { Doc } from "@automerge/automerge";
import * as Automerge from "@automerge/automerge";

export function unreadCount<Channel>(
  doc: Doc<Channel>,
  viewedHeads: Automerge.Heads,
): number {
  let count = 0;
  const patches = Automerge.diff(doc, viewedHeads, Automerge.getHeads(doc));
  for (const patch of patches) {
    if (
      patch.action == "put" &&
      patch.path.length == 2 &&
      patch.path[0] == "messages"
    ) {
      count += 1;
    }
  }
  return count;
}
