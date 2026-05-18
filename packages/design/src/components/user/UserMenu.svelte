<script lang="ts">
  import { Avatar } from "@foxui/core";
  import Popover from "../ui/popover/Popover.svelte";
  import Button from "../ui/button/Button.svelte";
  import ThemeSettings from "./ThemeSettings.svelte";

  let {
    connected,
    avatar,
    displayName,
    handle,
    profileHref,
    versionLabel,
    onLogout,
  }: {
    connected: boolean;
    /** Optional avatar URL */
    avatar?: string;
    displayName?: string;
    handle?: string;
    profileHref?: string;
    /** Pre-formatted version label (e.g. "Roomy 0.1.4 ( abc123 )"). */
    versionLabel?: string;
    onLogout: () => void;
  } = $props();

  let popoverOpen = $state(false);

  function handleLogout() {
    onLogout();
    popoverOpen = false;
  }
</script>

<Popover bind:open={popoverOpen} side="right" sideOffset={12} class="my-4 w-80">
  {#snippet child({ props })}
    <button
      {...props}
      class="cursor-pointer opacity-90 hover:opacity-100 transition-opacity duration-200 group overflow-hidden rounded-full border-2 border-solid"
      class:border-green-500={connected}
      class:border-red-500={!connected}
    >
      <Avatar
        src={avatar}
        fallback={displayName}
        class="group-hover:scale-110 transition-transform duration-200"
      ></Avatar>
      {#if handle}
        <span class="sr-only">{handle}</span>
      {:else}
        <span class="sr-only">Log in</span>
      {/if}
    </button>
  {/snippet}

  <div class="flex flex-col">
    {#if connected}
      <div
        class="border-b border-base-300 dark:border-base-700 pb-4 mb-2 flex items-center gap-2"
      >
        <Avatar
          src={avatar}
          fallback={displayName}
          class="group-hover:scale-110 transition-transform duration-200"
        ></Avatar>
        {#if profileHref}
          <a
            class="mr-auto font-medium truncate"
            title={handle ? `@${handle}` : undefined}
            href={profileHref}>@{handle}</a
          >
        {:else}
          <span class="mr-auto font-medium truncate">@{handle}</span>
        {/if}
        <Button variant="ghost" onclick={handleLogout}>Log Out</Button>
      </div>
    {/if}

    <ThemeSettings />

    {#if versionLabel}
      <div
        class="border-t border-base-300 dark:border-base-700 pt-2 mt-2 flex items-center gap-2"
      >
        <span class="opacity-50 text-xs">{versionLabel}</span>
      </div>
    {/if}
  </div>
</Popover>
