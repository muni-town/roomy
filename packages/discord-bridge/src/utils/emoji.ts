import type { Emoji } from "@discordeno/bot";

export function emojiToString(emoji: Partial<Emoji>): string {
  if (emoji.id) {
    const animated = emoji.animated ? "a" : "";
    return `<${animated}:${emoji.name || "_"}:${emoji.id}>`;
  }
  return emoji.name || "❓";
}

export function reactionKey(
  messageId: bigint,
  userId: bigint,
  emoji: Partial<Emoji>,
): string {
  const emojiKey = emoji.id ? emoji.id.toString() : emoji.name || "unknown";
  return `${messageId}:${userId}:${emojiKey}`;
}
