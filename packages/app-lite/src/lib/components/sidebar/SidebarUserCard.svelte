<script lang="ts" module>
  import { browser } from "$app/environment";
</script>

<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import {
    ContextMenu,
    ContextMenuItem,
    ContextMenuSeparator,
  } from "@roomy/design/components/ui/context-menu/index.js";
  import { buttonVariants } from "@roomy/design/components/ui/button/Button.svelte";
  import { IconEllipsisHorizontal, IconSettings, IconLogOut } from "@roomy/design/icons";
  import { logout, auth } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { goto } from "$app/navigation";

  const connected = $derived(!!sync_.ctx);

  // Reactive profile from auth module — updates immediately on login/init.
  // Falls back to localStorage for the initial render before the profile
  // fetch completes.
  let displayedProfile = $derived(
    auth.profile ?? (browser ? (() => {
      const raw = localStorage.getItem("last-login");
      return raw ? JSON.parse(raw) : undefined;
    })() : undefined),
  );

  let isDark = $state(false);

  $effect(() => {
    if (!browser) return;
    const stored = localStorage.getItem("darkMode");
    if (stored !== null) {
      isDark = JSON.parse(stored);
    } else {
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  });

  function toggleTheme() {
    isDark = !isDark;
    const root = document.documentElement;

    if (isDark) {
      root.classList.add("dark");
      localStorage.setItem("darkMode", JSON.stringify(true));
    } else {
      root.classList.remove("dark");
      localStorage.setItem("darkMode", JSON.stringify(false));
    }

    window.dispatchEvent(
      new CustomEvent("theme-changed", { detail: { darkMode: isDark } }),
    );
  }
</script>

<div class="shrink-0 px-2 pb-2 pt-1">
  <div
    class="flex items-center gap-3 w-full rounded-lg px-3 py-2 bg-white dark:bg-base-950 border border-base-500/20"
  >
    <div class="relative size-10 shrink-0">
      <div class="size-full rounded-full overflow-hidden">
        <UserAvatar
          src={displayedProfile?.avatar}
          name={displayedProfile?.did ?? displayedProfile?.handle ?? "user"}
          size={40}
          class="size-full"
        />
      </div>
      <div
        class="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-white dark:border-base-950"
        class:bg-green-500={connected}
        class:bg-red-500={!connected}
      ></div>
    </div>
    <div class="flex flex-col min-w-0 flex-1 text-left leading-none">
      <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate">
        {displayedProfile?.displayName ?? displayedProfile?.handle ?? "Log in"}
      </span>
      {#if displayedProfile?.displayName && displayedProfile?.handle}
        <span class="text-xs font-light text-base-400 dark:text-base-500 truncate -mt-1">
          @{displayedProfile.handle}
        </span>
      {/if}
    </div>
    <ContextMenu side="top" sideOffset={8} align="center">
      {#snippet trigger({ props })}
        <button
          {...props}
          class={buttonVariants({ variant: "ghost", size: "iconSm" })}
          aria-label="User menu"
        >
          <IconEllipsisHorizontal class="size-5" />
        </button>
      {/snippet}

      <ContextMenuItem onSelect={toggleTheme}>
        {#if isDark}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-4"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
            />
          </svg>
        {:else}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-4"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
            />
          </svg>
        {/if}
        {isDark ? "Light Mode" : "Dark Mode"}
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => goto("/user/settings")}>
        <IconSettings class="size-4" />
        Settings
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem variant="danger" onSelect={logout}>
        <IconLogOut class="size-4" />
        Log Out
      </ContextMenuItem>
    </ContextMenu>
  </div>
</div>