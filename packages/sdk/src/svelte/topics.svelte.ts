/**
 * `useTopicSubscription()` — Svelte rune for refcounted topic sub/unsub
 * tied to component lifecycle via `$effect`.
 *
 * Accepts getter functions so topics can depend on reactive state (e.g.
 * `selectedRoomId`). When the topics change, old subscriptions are released
 * and new ones acquired. When the component unmounts, all holds are released.
 *
 * @module @roomy-space/sdk/svelte
 */

import type { Topic } from "../sync/connection";

/**
 * Structural interface for the SDK's `TopicManager`.
 *
 * Only exposes `acquire`, which is all the Svelte adapter needs.
 * Using an interface avoids nominal-type mismatches caused by
 * private fields on the concrete class when dist and source
 * resolution paths differ.
 */
export interface TopicManagerLike {
  acquire(topic: Topic): () => void;
}

/**
 * Subscribe to topics via the SDK's refcounted {@link TopicManager}.
 *
 * The manager is provided through a getter so the hook can adapt if the
 * `TopicManager` is replaced (e.g. when the sync connection is recreated).
 * Topics are also provided through a getter so they can read reactive state.
 *
 * ```svelte
 * <script>
 *   import { useTopicSubscription } from "@roomy-space/sdk/svelte";
 *   useTopicSubscription(
 *     () => syncCtx?.topicManager ?? null,
 *     () => [
 *       selectedSpaceId ? { kind: "space", id: selectedSpaceId } : null,
 *       selectedRoomId ? { kind: "room", id: selectedRoomId } : null,
 *     ].filter(Boolean),
 *   );
 * </script>
 * ```
 *
 * @param getManager — function returning the current `TopicManager`
 *   (or `null` if not yet available). Reactive reads are tracked.
 * @param getTopics — function returning the current topic list.
 *   Reactive reads are tracked. Empty array is a safe no-op.
 */
export function useTopicSubscription(
  getManager: () => TopicManagerLike | null,
  getTopics: () => Topic[],
): void {
  $effect(() => {
    const manager = getManager();
    if (!manager) return;

    const topics = getTopics();
    const disposers = topics.map((t) => manager.acquire(t));

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
