/**
 * Which query kinds opt out of the persisted cache.
 *
 * The persisted set is one count-capped snapshot (`MAX_PERSISTED_ENTRIES`,
 * `$lib/client.ts`) shared by every query in the cache, oldest-written first
 * out. A per-message lookup — `space.roomy.message.getMessage`, created once
 * per rendered reply context (`MessageContextReply.svelte`) — is both the most
 * numerous kind and the least self-sufficient: its value is a single row that
 * is already inside the persisted `room.getMessages` page for the same room.
 * Left in the snapshot, a session that scrolls a busy room fills the cap with
 * single-message entries and evicts the room lists and headers the snapshot
 * exists to keep.
 *
 * The lookup stays useful without persistence: it is seeded from the room
 * list the client already holds (`initialData` in `$lib/queries/message.ts`),
 * so a restored room list renders its reply previews from that page; only a
 * reply whose target is outside the cached page refetches, once, for the one
 * reply that needs it.
 *
 * The SDK's `isPersistableQuery` honours `meta.persist === false`; this object
 * is the only place the app opts out.
 */
export const MESSAGE_QUERY_META = { persist: false } as const;
