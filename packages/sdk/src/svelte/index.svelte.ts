/**
 * Svelte adapter for `@roomy-space/sdk`.
 *
 * Re-exports the Svelte-specific rune wrappers for connection status,
 * topic subscriptions, and reactive queries. Import from
 * `@roomy-space/sdk/svelte` in Svelte 5 components.
 *
 * **Peer dependencies** (optional — only needed if you import this module):
 *   - `svelte` ≥ 5.0
 *   - `@tanstack/svelte-query` ≥ 6.0 (only for `createReactiveQuery`)
 *
 * This module uses `.svelte.ts` so the Svelte compiler processes the
 * `$state` / `$effect` runes. The consumer's bundler (Vite + Svelte
 * plugin) handles compilation.
 *
 * @module @roomy-space/sdk/svelte
 */

export {
  useConnectionStatus,
  type ConnectionState,
  type SyncConnectionLike,
} from "./connection.svelte";

export {
  useTopicSubscription,
  type TopicManagerLike,
} from "./topics.svelte";

export {
  createReactiveQuery,
  type ReactiveQueryDef,
} from "./query.svelte";

// Re-export Topic type for convenience — consumers of the svelte adapter
// almost always need it when calling useTopicSubscription or
// createReactiveQuery.
export type { Topic } from "../sync/connection";
