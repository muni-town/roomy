<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  type ActorSuggestion = {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };

  let {
    value = $bindable(""),
    placeholder = "name.bsky.social",
    disabled = false,
    onSelect,
  }: {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    onSelect?: (handle: string) => void;
  } = $props();

  let query = $state("");
  let open = $state(false);
  let activeIndex = $state(0);
  let suggestions = $state<ActorSuggestion[]>([]);
  let loading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Sync query from parent value changes (e.g. last-login click)
  $effect(() => {
    if (value && !query) {
      query = value;
    }
  });

  async function searchActors(q: string) {
    if (!q || q.length < 2) {
      suggestions = [];
      open = false;
      return;
    }

    loading = true;
    try {
      // searchActorsTypeahead is an App View endpoint, not a PDS endpoint.
      // It must be called against the Bluesky App View API (api.bsky.app),
      // not against the user's PDS. The public API works without auth.
      const appviewUrl = new URL("https://api.bsky.app");
      appviewUrl.pathname = "/xrpc/app.bsky.actor.searchActorsTypeahead";
      appviewUrl.searchParams.set("q", q);
      appviewUrl.searchParams.set("limit", "8");

      const resp = await fetch(appviewUrl, {
        headers: [["accept", "application/json"]],
      });

      if (!resp.ok) {
        suggestions = [];
        open = false;
        return;
      }

      const data = await resp.json();
      suggestions = (data.actors ?? []).slice(0, 8);

      open = suggestions.length > 0;
      activeIndex = 0;
    } catch {
      suggestions = [];
      open = false;
    } finally {
      loading = false;
    }
  }

  function onInput(e: Event) {
    const target = e.target as HTMLInputElement;
    query = target.value;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchActors(query);
    }, 200);
  }

  function selectSuggestion(suggestion: ActorSuggestion) {
    const handle = suggestion.handle;
    query = handle;
    value = handle;
    open = false;
    onSelect?.(handle);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open || suggestions.length === 0) {
      // Allow Enter to submit even when dropdown is closed
      if (e.key === "Enter") {
        value = query;
        onSelect?.(query);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const suggestion = suggestions[activeIndex];
      if (suggestion) {
        selectSuggestion(suggestion);
      } else {
        // No suggestion selected — submit with raw query
        value = query;
        onSelect?.(query);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      open = false;
    }
  }

  function onFocusOut(e: FocusEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      // Delay closing so click on suggestion registers
      setTimeout(() => {
        open = false;
      }, 150);
    }
  }

  function displayName(suggestion: ActorSuggestion): string {
    return suggestion.displayName || suggestion.handle;
  }
</script>

<div class="relative" onfocusin={() => query.length >= 2 && (open = true)} onfocusout={onFocusOut}>
  <input
    type="text"
    name="handle"
    id="atproto-handle"
    autocomplete="username"
    placeholder={placeholder}
    {disabled}
    value={query}
    oninput={onInput}
    onkeydown={onKeyDown}
    class="w-full text-sm py-2 px-3 rounded-lg ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 outline-none border-0 transition-colors"
  />

  {#if loading}
    <div
      class="absolute right-3 top-1/2 -translate-y-1/2"
    >
      <svg
        class="animate-spin size-4 text-base-400"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          class="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          stroke-width="4"
        />
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    </div>
  {/if}

  {#if open && suggestions.length > 0}
    <ul
      class="absolute z-20 top-full mt-1 left-0 right-0 rounded-2xl border border-base-200 dark:border-base-800 bg-base-100/90 dark:bg-base-900/90 backdrop-blur-xl shadow-lg overflow-hidden py-1"
    >
      {#each suggestions as suggestion, i}
        <li class="mx-1">
          <button
            type="button"
            class={[
              "w-full flex items-center gap-2.5 px-3 py-1.5 text-left rounded-xl",
              i === activeIndex
                ? "bg-accent-500/10 dark:bg-accent-500/15"
                : "hover:bg-base-100 dark:hover:bg-base-800",
            ]}
            onmousedown={() => selectSuggestion(suggestion)}
            onmouseover={() => (activeIndex = i)}
            onfocus={() => (activeIndex = i)}
          >
            <Avatar.Root class="size-6 shrink-0 rounded-full">
              {#if suggestion.avatar}
                <Avatar.Image src={suggestion.avatar} class="rounded-full" />
              {/if}
              <Avatar.Fallback>
                <AvatarBeam name={suggestion.did} size={24} />
              </Avatar.Fallback>
            </Avatar.Root>
            <span
              class="text-sm font-medium text-base-900 dark:text-base-100 truncate"
            >
              {displayName(suggestion)}
            </span>
            {#if suggestion.handle && suggestion.displayName}
              <span class="text-xs text-base-400 truncate">@{suggestion.handle}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
