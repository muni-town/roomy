<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  export type TypeaheadUser = {
    did: string;
    handle?: string;
    name?: string;
    avatar?: string;
  };

  let {
    users,
    excluded = [],
    onSelect,
    placeholder = "Search members...",
  }: {
    users: TypeaheadUser[];
    excluded?: string[];
    onSelect: (user: TypeaheadUser) => void;
    placeholder?: string;
  } = $props();

  let query = $state("");
  let open = $state(false);
  let activeIndex = $state(0);

  const filteredUsers = $derived.by(() => {
    const q = query.toLowerCase().trim();
    const excludedSet = new Set(excluded);
    const candidates = users.filter((u) => !excludedSet.has(u.did));
    if (!q) return candidates.slice(0, 6);
    return candidates
      .filter(
        (u) =>
          u.name?.toLowerCase().includes(q) ||
          u.handle?.toLowerCase().includes(q) ||
          u.did.toLowerCase().includes(q),
      )
      .slice(0, 6);
  });

  $effect(() => {
    // Reset active index when results change
    filteredUsers;
    activeIndex = 0;
  });

  function select(user: TypeaheadUser) {
    onSelect(user);
    query = "";
    open = false;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open || filteredUsers.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filteredUsers.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const user = filteredUsers[activeIndex];
      if (user) select(user);
    } else if (e.key === "Escape") {
      open = false;
      query = "";
    }
  }

  function onFocusOut(e: FocusEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      open = false;
    }
  }

  function displayName(user: TypeaheadUser) {
    return user.name || user.handle || user.did;
  }
</script>

<div class="relative" onfocusin={() => (open = true)} onfocusout={onFocusOut}>
  <input
    type="text"
    name="Add Member"
    bind:value={query}
    {placeholder}
    onkeydown={onKeyDown}
    class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl px-3 py-1.5 text-sm font-medium outline-none border-0 transition-colors"
  />

  {#if open && filteredUsers.length > 0}
    <ul
      class="absolute z-20 top-full mt-1 left-0 right-0 rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg overflow-hidden py-1"
    >
      {#each filteredUsers as user, i}
        <li class="mx-1">
          <button
            class={[
              "w-full flex items-center gap-2.5 px-3 py-1.5 text-left rounded-xl",
              i === activeIndex
                ? "bg-accent-500/10 dark:bg-accent-500/15"
                : "hover:bg-base-100 dark:hover:bg-base-800",
            ]}
            onmousedown={() => select(user)}
            onmouseover={() => (activeIndex = i)}
            onfocus={() => (activeIndex = i)}
          >
            <Avatar.Root class="size-6 shrink-0 rounded-full">
              <Avatar.Image src={user.avatar} class="rounded-full" />
              <Avatar.Fallback>
                <AvatarBeam name={user.did} size={24} />
              </Avatar.Fallback>
            </Avatar.Root>
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
  {/if}
</div>
