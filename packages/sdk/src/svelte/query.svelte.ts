/**
 * `createReactiveQuery()` — wraps TanStack's `createQuery` and
 * `useTopicSubscription` in a single call, so a query factory + its topic
 * dependency is one line at the call site.
 *
 * @module @roomy-space/sdk/svelte
 */

import { createQuery } from "@tanstack/svelte-query";
import type { TopicManagerLike } from "./topics.svelte";
import type { Topic } from "../sync/connection";

/**
 * A reactive query definition. All fields are provided through a function
 * so they can read reactive state.
 */
export interface ReactiveQueryDef<TQueryFnData> {
  /** TanStack query key. */
  queryKey: unknown[];
  /** TanStack query function — fetches data from the appserver. */
  queryFn: () => Promise<TQueryFnData>;
  /**
   * Topics to subscribe to for real-time updates. Automatically refcounted:
   * the first subscriber sends `sub`, the last release sends `unsub`.
   */
  topics: Topic[];
  /** The `TopicManager` to acquire subscriptions from. */
  topicManager: TopicManagerLike;
}

/**
 * Create a TanStack query that automatically subscribes to sync topics.
 *
 * Combines `createQuery` from `@tanstack/svelte-query` with the SDK's
 * refcounted topic manager. The query re-fetches when the query key changes;
 * the topic subscription updates in lockstep.
 *
 * ```svelte
 * {@const messagesQuery = createReactiveQuery(() => ({
 *   queryKey: [NSID.GET_MESSAGES, { roomId: selectedRoomId! }],
 *   queryFn: async () => {
 *     const res = await fetchMessages(agent, did, selectedRoomId!, 50)();
 *     return res.messages;
 *   },
 *   topics: selectedRoomId ? [{ kind: "room", id: selectedRoomId }] : [],
 *   topicManager: syncCtx.topicManager,
 * }))}
 * ```
 *
 * @param def — function returning the current query definition. Reactive
 *   reads inside the function are tracked by both TanStack and the
 *   `$effect` that manages topic subscriptions.
 */
export function createReactiveQuery<TQueryFnData>(
  def: () => ReactiveQueryDef<TQueryFnData>,
) {
  // Create the TanStack query with reactive options.
  const query = createQuery<TQueryFnData>(() => {
    const { queryKey, queryFn } = def();
    return { queryKey, queryFn };
  });

  // Subscribe to topics reactively. The $effect cleanup releases the
  // previous holds when the definition changes (e.g. roomId changes).
  $effect(() => {
    const { topics, topicManager } = def();
    const disposers = topics.map((t) => topicManager.acquire(t));
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  return query;
}
