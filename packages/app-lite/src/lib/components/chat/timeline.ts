/**
 * Timeline merge grouping.
 *
 * A message renders its author header only when it does NOT merge with the
 * previous row; merged rows continue the previous author's group. The group is
 * therefore keyed on the identity the row actually DISPLAYS.
 *
 * A forward displays the ORIGINAL author and timestamp (see `ChatMessage`),
 * and renders its own "forwarded" context line above. It is a self-contained
 * unit, so it is a hard boundary for merging: it never merges, and nothing
 * merges into it. Keying on the forwarder's `authorDid` instead (the
 * materialiser keeps the forwarder as the author) put the forward in the
 * forwarder's group while displaying the original's identity — so a message
 * the forwarder sent right after a forward read as the ORIGINAL author's.
 *
 * Kept free of Svelte and DOM so the rule stays unit-testable; `ChatArea`
 * calls it over the query data.
 */

import type { Message } from "$lib/queries/messages";

/** Two messages by the same author within this window form one group. */
const MERGE_WINDOW_MS = 5 * 60 * 1000;

export type TimelineMessage = Message & { mergeWithPrevious: boolean };

/**
 * Flags each message with whether it merges into the previous row's group.
 *
 * Input order is preserved as given (the query data is already chronological).
 */
export function mergeTimeline(messages: Message[]): TimelineMessage[] {
  return messages.map((message, index) => {
    const prev = index > 0 ? (messages[index - 1] ?? null) : null;
    return {
      ...message,
      mergeWithPrevious: mergesIntoPrevious(prev, message),
    };
  });
}

function mergesIntoPrevious(
  prev: Message | null,
  message: Message,
): boolean {
  if (!prev) return false;
  // A forward is a unit of its own (it carries a context line and shows the
  // original's identity), so it neither merges nor is merged into.
  if (prev.forwardedFrom || message.forwardedFrom) return false;
  if (!message.authorDid || prev.authorDid !== message.authorDid) return false;
  if (message.replyTo) return false;
  const elapsed =
    new Date(message.timestamp || 0).getTime() -
    new Date(prev.timestamp || 0).getTime();
  return elapsed < MERGE_WINDOW_MS;
}
