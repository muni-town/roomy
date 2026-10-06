<script lang="ts" module>
  import { browser } from "$app/environment";
</script>

<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import {
    ContextMenu,
    ContextMenuItem,
    ContextMenuSeparator,
  } from "@roomy/design/components/ui/context-menu/index.js";
  import { buttonVariants } from "@roomy/design/components/ui/button/Button.svelte";
  import {
    applyThemeMode,
    initSystemThemeListener,
    nextThemeMode,
    readThemeMode,
  } from "@roomy/design/utils";
  import type { ThemeMode } from "@roomy/design/utils";
  import { IconEllipsisHorizontal, IconSettings, IconLogOut } from "@roomy/design/icons";
  import { logout, auth } from "$lib/auth.svelte";
  import { lastLogin } from "$lib/last-login.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { queryHealth } from "$lib/query-health.svelte";
  import { goto } from "$app/navigation";

  /**
   * What the dot on the avatar says: green while the sync socket is up and
   * nothing failed, grey while a value is being shown whose refresh did not go
   * through, red when there is no socket and nothing to fall back on.
   *
   * Stale wins over the socket's own presence: while the appserver is
   * unreachable the WS may still read as connected for a moment before the
   * reconnect, and the value on screen is stale in either case.
   */
  const connection = $derived(
    queryHealth.staleCount > 0 ? "stale" : sync_.ctx ? "online" : "offline",
  );

  // Reactive profile from auth module — updates immediately on login/init.
  // Falls back to the last-login record for the initial render before the
  // profile fetch completes. That record's handle is verified against its DID
  // before use (see `last-login.svelte.ts`), so a renamed account cannot
  // surface a handle that no longer resolves.
  let displayedProfile = $derived(auth.profile ?? lastLogin.current ?? undefined);

  let themeMode = $state<ThemeMode>("system");

  $effect(() => {
    if (!browser) return;
    themeMode = readThemeMode();
    return initSystemThemeListener();
  });

  function toggleTheme() {
    themeMode = nextThemeMode(themeMode);
    applyThemeMode(themeMode);
  }
</script>

<div class="shrink-0 px-2 pb-2 pt-1">
  <div
    class="flex items-center gap-3 w-full rounded-lg px-3 py-2 bg-white dark:bg-base-950 border border-base-500/20 mb-[env(safe-area-inset-bottom)] shadow-lift"
  >
    <div class="relative size-10 shrink-0">
      <div class="size-full rounded-full overflow-hidden">
        <UserAvatar
          src={resolveBlobUrl(displayedProfile?.avatar)}
          name={displayedProfile?.did ?? displayedProfile?.handle ?? "user"}
          size={40}
          class="size-full"
        />
      </div>
      <div
        class="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-white dark:border-base-950"
        data-status={connection}
        class:bg-green-500={connection === "online"}
        class:bg-base-400={connection === "stale"}
        class:bg-red-500={connection === "offline"}
      ></div>
    </div>
    <a
      href={`/user/${auth.userDid}`}
      class="flex flex-col min-w-0 flex-1 text-left leading-none"
    >
      <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate">
        {displayedProfile?.displayName ?? displayedProfile?.handle ?? "Log in"}
      </span>
      {#if displayedProfile?.displayName && displayedProfile?.handle}
        <span class="text-xs font-light text-base-400 dark:text-base-500 truncate -mt-1">
          @{displayedProfile.handle}
        </span>
      {/if}
    </a>
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
        {#if themeMode === "light"}
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
        {:else if themeMode === "dark"}
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
              d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25"
            />
          </svg>
        {/if}
        {themeMode === "light"
          ? "Light Mode"
          : themeMode === "dark"
            ? "Dark Mode"
            : "System Mode"}
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