<script lang="ts">
  /**
   * Presentational list of typeahead users — the avatar + name + handle rows
   * shared by `UserTypeahead` (the standalone input) and the TipTap `@mention`
   * suggestion renderer. Pure: the parent owns `activeIndex`, keyboard nav, and
   * the data source (local filter or server search).
   */
  import UserAvatar from "../../user/UserAvatar.svelte";
  import type { TypeaheadUser } from "./types";

  let {
    users,
    activeIndex = 0,
    onSelect,
    onHover,
    class: klass = "",
  }: {
    users: TypeaheadUser[];
    activeIndex?: number;
    onSelect: (user: TypeaheadUser) => void;
    onHover?: (index: number) => void;
    class?: string;
  } = $props();

  function displayName(user: TypeaheadUser) {
    return user.name || user.handle || user.did;
  }
</script>

<ul
  class="rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg overflow-hidden py-1 {klass}"
>
  {#each users as user, i}
    <li class="mx-1">
      <button
        class={[
          "w-full flex items-center gap-2.5 px-3 py-1.5 text-left rounded-xl",
          i === activeIndex
            ? "bg-accent-500/10 dark:bg-accent-500/15"
            : "hover:bg-base-100 dark:hover:bg-base-800",
        ]}
        onmousedown={(e) => {
          // Prevent the button from stealing focus so the editor (TipTap) /
          // input keeps focus after a click-selection — the selection handler
          // and the Mention command's `.focus()` then remain in effect.
          e.preventDefault();
          onSelect(user);
        }}
        onmouseover={() => onHover?.(i)}
        onfocus={() => onHover?.(i)}
      >
        <UserAvatar
          src={user.avatar}
          name={user.did}
          size={24}
          class="size-6 shrink-0 rounded-full"
        />
        <span
          class="text-sm font-medium text-base-900 dark:text-base-100 truncate"
        >
          {displayName(user)}
        </span>
        {#if user.handle && user.name}
          <span class="text-xs text-base-400 truncate">@{user.handle}</span>
        {/if}
      </button>
    </li>
  {/each}
</ul>