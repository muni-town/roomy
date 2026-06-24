<script lang="ts">
  /**
   * Floating suggestion list for the TipTap `@mention` extension.
   *
   * Mounted imperatively by `initUserMention`'s suggestion `render` lifecycle
   * (see `$lib/tiptap/editor.ts`). The editor owns the query text (whatever the
   * user types after `@`); this component just renders results and forwards
   * keyboard navigation. Results / loading / empty-state text are driven from
   * the render object via the exported `setItems` / `setLoading` /
   * `setEmptyMessage` handlers — the same imperative contract `SuggestionSelect`
   * uses.
   *
   * Reuses `UserTypeaheadList` so the avatar + name + handle rows match the
   * standalone `UserTypeahead` component exactly.
   */
  import UserTypeaheadList from "@roomy/design/components/ui/user-typeahead/UserTypeaheadList.svelte";
  import { IconLoading } from "@roomy/design/icons";
  import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";

  let {
    callback,
  }: {
    callback: (user: TypeaheadUser) => void;
  } = $props();

  let items = $state<TypeaheadUser[]>([]);
  let activeIndex = $state(0);
  let loading = $state(false);
  /** Shown when there are no items and not loading. */
  let emptyMessage = $state("Type to search members");

  export function setItems(value: TypeaheadUser[]) {
    items = value;
    activeIndex = 0;
  }

  export function setLoading(value: boolean) {
    loading = value;
  }

  export function setEmptyMessage(message: string) {
    emptyMessage = message;
  }

  export function onKeyDown(event: KeyboardEvent): boolean {
    if (event.repeat) return false;
    if (items.length === 0) return false;
    switch (event.key) {
      case "ArrowUp":
        activeIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
        return true;
      case "ArrowDown":
        activeIndex = activeIndex >= items.length - 1 ? 0 : activeIndex + 1;
        return true;
      case "Enter": {
        const selected = items[activeIndex];
        if (selected) callback(selected);
        return true;
      }
    }
    return false;
  }

  function select(user: TypeaheadUser) {
    callback(user);
  }
</script>

<div class="text-base-900 dark:text-base-100">
  {#if loading}
    <div
      class="rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg px-3 py-2 flex items-center gap-2 text-sm text-base-400"
    >
      <IconLoading class="size-4 animate-spin" />
      Searching members…
    </div>
  {:else if items.length > 0}
    <UserTypeaheadList
      users={items}
      {activeIndex}
      onSelect={select}
      onHover={(i) => (activeIndex = i)}
    />
  {:else}
    <div
      class="rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg px-3 py-1.5 text-sm text-base-400"
    >
      {emptyMessage}
    </div>
  {/if}
</div>