<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import Popover from "@roomy/design/components/ui/popover/Popover.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ThemeSettings from "@roomy/design/components/user/ThemeSettings.svelte";
  import { IconEllipsisHorizontal, IconSettings } from "@roomy/design/icons";
  import { logout } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";

  const connected = $derived(!!sync_.ctx);

  type LastLogin = { handle: string; did: string; avatar: string };
  let lastLogin = $state<LastLogin | undefined>(undefined);

  const versionLabel = $derived(
    `Roomy ${__APP_VERSION__}${__BUILD_ID__ ? ` ( ${__BUILD_ID__} )` : ""}`,
  );

  $effect(() => {
    const raw = localStorage.getItem("last-login");
    lastLogin = raw ? JSON.parse(raw) : undefined;
  });
</script>

<div class="shrink-0 px-2 pb-2 pt-1">
  <Popover side="right" sideOffset={12} class="my-4 w-80">
    {#snippet child({ props })}
      <button
        {...props}
        class="flex items-center gap-3 w-full rounded-lg px-3 py-2 bg-white dark:bg-base-950 border border-base-500/20 hover:border-accent-500/40 dark:hover:bg-base-900 transition-colors cursor-pointer group"
      >
        <div class="relative size-10 shrink-0">
          <div class="size-full rounded-full overflow-hidden">
            <UserAvatar
              src={lastLogin?.avatar}
              name={lastLogin?.did ?? lastLogin?.handle ?? "user"}
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
        <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate min-w-0 flex-1 text-left">
          {lastLogin?.handle ?? "Log in"}
        </span>
        <IconEllipsisHorizontal class="size-5 text-base-400 shrink-0" />
      </button>
    {/snippet}

    <div class="flex flex-col">
      {#if connected}
        <div class="border-b border-base-300 dark:border-base-700 pb-4 mb-2 flex items-center gap-2">
          <UserAvatar
            src={lastLogin?.avatar}
            name={lastLogin?.did ?? lastLogin?.handle ?? "user"}
            size={32}
            class="size-8 rounded-full"
          />
          <span class="mr-auto font-medium truncate">@{lastLogin?.handle}</span>
          <Button variant="ghost" onclick={logout}>Log Out</Button>
        </div>
      {/if}

      <a
        href="/user/settings"
        class="flex items-center gap-2 px-1 py-2 text-sm font-medium text-base-700 dark:text-base-300 hover:text-base-900 dark:hover:text-base-100 transition-colors rounded-md hover:bg-base-300/30 dark:hover:bg-base-800/30"
      >
        <IconSettings class="size-4" />
        Settings
      </a>

      <ThemeSettings />

      {#if versionLabel}
        <div class="border-t border-base-300 dark:border-base-700 pt-2 mt-2 flex items-center gap-2">
          <span class="opacity-50 text-xs">{versionLabel}</span>
        </div>
      {/if}
    </div>
  </Popover>
</div>