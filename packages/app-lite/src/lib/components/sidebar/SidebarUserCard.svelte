<script lang="ts">
  import { Avatar } from "@foxui/core";
  import Popover from "@roomy/design/components/ui/popover/Popover.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ThemeSettings from "@roomy/design/components/user/ThemeSettings.svelte";
  import { logout } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";

  const connected = $derived(!!sync_.ctx);

  type LastLogin = { handle: string; did: string; avatar: string };
  let lastLogin = $state<LastLogin | undefined>(undefined);

  let { side = "right" }: { side?: "top" | "right" | "bottom" | "left" } = $props();

  const versionLabel = $derived(
    `Roomy ${__APP_VERSION__}${__BUILD_ID__ ? ` ( ${__BUILD_ID__} )` : ""}`,
  );

  $effect(() => {
    const raw = localStorage.getItem("last-login");
    lastLogin = raw ? JSON.parse(raw) : undefined;
  });
</script>

<div class="shrink-0 px-1">
  <Popover {side} sideOffset={12} class="my-4 w-80">
    {#snippet child({ props })}
      <button
        {...props}
        class="flex items-center gap-2 pl-2 pr-1 py-0.5 rounded-md hover:bg-base-200/60 dark:hover:bg-base-800/60 transition-colors cursor-pointer group"
      >
        <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate max-w-32 text-right hidden sm:block">
          {lastLogin?.handle ?? "Log in"}
        </span>
        <div class="relative size-7 shrink-0">
          <div class="size-full rounded-full overflow-hidden">
            <Avatar
              src={lastLogin?.avatar}
              fallback={lastLogin?.handle}
              class="size-full"
            />
          </div>
          <div
            class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white dark:border-base-950"
            class:bg-green-500={connected}
            class:bg-red-500={!connected}
          ></div>
        </div>
      </button>
    {/snippet}

    <div class="flex flex-col">
      {#if connected}
        <div class="border-b border-base-300 dark:border-base-700 pb-4 mb-2 flex items-center gap-2">
          <Avatar
            src={lastLogin?.avatar}
            fallback={lastLogin?.handle}
            class="size-8 rounded-full"
          />
          <span class="mr-auto font-medium truncate">@{lastLogin?.handle}</span>
          <Button variant="ghost" onclick={logout}>Log Out</Button>
        </div>
      {/if}

      <ThemeSettings />

      {#if versionLabel}
        <div class="border-t border-base-300 dark:border-base-700 pt-2 mt-2 flex items-center gap-2">
          <span class="opacity-50 text-xs">{versionLabel}</span>
        </div>
      {/if}
    </div>
  </Popover>
</div>