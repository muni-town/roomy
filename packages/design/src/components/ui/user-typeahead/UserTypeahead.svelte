<script module lang="ts">
  // Re-export so existing importers (`import type { TypeaheadUser } from
  // ".../UserTypeahead.svelte"`) keep working now that the type lives in
  // ./types.
  export type { TypeaheadUser } from "./types";
</script>

<script lang="ts">
  import { IconLoading } from "@roomy/design/icons";
  import UserTypeaheadList from "./UserTypeaheadList.svelte";
  import type { TypeaheadUser } from "./types";

  let {
    /**
     * Local list used for client-side filtering (the fallback when no `search`
     * fetcher is supplied) AND for the empty-query state in server-search mode
     * (so the dropdown is instantly populated before the user types).
     */
    users = [],
    /**
     * Optional server-search fetcher. When supplied, non-empty input is
     * debounced and routed through this callback instead of filtering `users`
     * locally — used by the mention typeahead, which hits
     * `space.roomy.space.getMembers?search=` on the appserver. The call site
     * owns the transport (the design package stays transport-agnostic).
     */
    search,
    excluded = [],
    onSelect,
    placeholder = "Search members...",
    debounce = 200,
    limit = 6,
  }: {
    users?: TypeaheadUser[];
    search?: (query: string) => Promise<TypeaheadUser[]>;
    excluded?: string[];
    onSelect: (user: TypeaheadUser) => void;
    placeholder?: string;
    debounce?: number;
    limit?: number;
  } = $props();

  let query = $state("");
  let open = $state(false);
  let activeIndex = $state(0);
  let loading = $state(false);
  /** Raw results from the last `search` call (exclusion/limit applied later). */
  let serverResults = $state<TypeaheadUser[]>([]);
  /** Monotonic request id so stale server responses are discarded. */
  let currentReq = 0;

  const excludedSet = $derived(new Set(excluded));

  // Client-filtered list — used when no `search` fetcher is supplied.
  const clientFiltered = $derived.by(() => {
    const q = query.toLowerCase().trim();
    const candidates = users.filter((u) => !excludedSet.has(u.did));
    if (!q) return candidates.slice(0, limit);
    return candidates
      .filter(
        (u) =>
          u.name?.toLowerCase().includes(q) ||
          u.handle?.toLowerCase().includes(q) ||
          u.did.toLowerCase().includes(q),
      )
      .slice(0, limit);
  });

  // In server-search mode the empty-query state reuses `users` (instant); once
  // the user types, we show the debounced `serverResults`.
  const filteredUsers = $derived.by(() => {
    if (!search) return clientFiltered;
    const pool = query.trim() === "" ? users : serverResults;
    return pool.filter((u) => !excludedSet.has(u.did)).slice(0, limit);
  });

  const showNoMatches = $derived(
    !!search && query.trim() !== "" && !loading && filteredUsers.length === 0,
  );

  // Debounced server search with stale-response guarding. Only `query` and
  // `search` are tracked here; exclusion/limit are applied in `filteredUsers`.
  $effect(() => {
    const q = query;
    const searchFn = search;
    if (!searchFn) return;
    const trimmed = q.trim();
    if (trimmed === "") {
      serverResults = [];
      loading = false;
      return;
    }
    loading = true;
    const reqId = ++currentReq;
    const t = setTimeout(async () => {
      try {
        const res = await searchFn(trimmed);
        if (reqId !== currentReq) return; // a newer query superseded this one
        serverResults = res;
      } catch {
        if (reqId === currentReq) serverResults = [];
      } finally {
        if (reqId === currentReq) loading = false;
      }
    }, debounce);
    return () => clearTimeout(t);
  });

  $effect(() => {
    // Reset active index when results change.
    filteredUsers;
    activeIndex = 0;
  });

  function select(user: TypeaheadUser) {
    onSelect(user);
    query = "";
    serverResults = [];
    open = false;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      if (filteredUsers.length === 0) return;
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filteredUsers.length - 1);
    } else if (e.key === "ArrowUp") {
      if (filteredUsers.length === 0) return;
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const user = filteredUsers[activeIndex];
      if (user) select(user);
    } else if (e.key === "Escape") {
      open = false;
      query = "";
      serverResults = [];
    }
  }

  function onFocusOut(e: FocusEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      open = false;
    }
  }
</script>

<div class="relative" onfocusin={() => (open = true)} onfocusout={onFocusOut}>
  <div class="relative">
    <input
      type="text"
      name="Add Member"
      bind:value={query}
      {placeholder}
      onkeydown={onKeyDown}
      class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl px-3 py-1.5 text-sm font-medium outline-none border-0 transition-colors"
    />
    {#if loading}
      <IconLoading
        class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-base-400 animate-spin"
      />
    {/if}
  </div>

  {#if open && filteredUsers.length > 0}
    <div class="absolute z-20 top-full mt-1 left-0 right-0">
      <UserTypeaheadList
        users={filteredUsers}
        {activeIndex}
        onSelect={select}
        onHover={(i) => (activeIndex = i)}
      />
    </div>
  {:else if open && showNoMatches}
    <div
      class="absolute z-20 top-full mt-1 left-0 right-0 rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg overflow-hidden py-1.5 px-3 text-sm text-base-400"
    >
      No matching members
    </div>
  {/if}
</div>