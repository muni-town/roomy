import type { ReactionList, RoomyAccount } from "$lib/jazz/schema";
import type { co, Loaded } from "jazz-tools";

export function convertReactionsToEmojis(
  reactions: Loaded<typeof ReactionList> | undefined | null,
  me: co.loaded<typeof RoomyAccount> | undefined | null,
) {
  if (!reactions) return [];

  // convert to [emoji, count, user (if current user has reacted with that emoji), users array]
  const emojiMap = new Map<
    string,
    {
      count: number;
      user: boolean;
      users: { id: string; name: string }[];
    }
  >();

  for (const reaction of reactions) {
    if (!reaction || !reaction.emoji) continue;
    let emoji = reaction.emoji;
    let obj = emojiMap.get(emoji);
    const reactorName = reaction._edits.emoji?.by?.profile?.name || "Unknown";
    const reactorId = reaction._edits.emoji?.by?.profile?.id;

    if (obj) {
      obj.count++;
      if (reactorId) {
        obj.users.push({ id: reactorId, name: reactorName });
      }
    } else {
      obj = {
        count: 1,
        user: false,
        users: reactorId ? [{ id: reactorId, name: reactorName }] : [],
      };
      emojiMap.set(emoji, obj);
    }

    if (reactorId === me?.profile?.id) {
      obj.user = true;
    }
  }

  let array = Array.from(emojiMap.entries())
    .map(([emoji, obj]) => ({
      emoji,
      count: obj.count,
      user: obj.user,
      users: obj.users,
    }))
    .sort((a, b) => b.emoji.localeCompare(a.emoji));
  return array;
}
