<script lang="ts">
  import { Avatar } from "@foxui/core";
  import Popover from "$lib/components/ui/popover/Popover.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import ThemeSettings from "./ThemeSettings.svelte";
  import { peer, peerStatus } from "$lib/workers";

  let popoverOpen = $state(false);

  const connected = $derived(peerStatus.authState?.state === "authenticated");

  function handleLogout() {
    peer.logout().then(() => {
      popoverOpen = false;
      window.location.reload();
    });
  }
</script>

<Popover
  bind:open={popoverOpen}
  side="right"
  sideOffset={12}
  class="my-4 max-w-80"
>
  {#snippet child({ props })}
    <button
      {...props}
      class="cursor-pointer opacity-90 hover:opacity-100 transition-opacity duration-200 group overflow-hidden rounded-full border-2 border-solid"
      class:border-green-500={connected}
      class:border-red-500={!connected}
    >
      <Avatar
        src={peerStatus.profile?.avatar}
        fallback={peerStatus.profile?.displayName}
        class="group-hover:scale-110 transition-transform duration-200"
      ></Avatar>
      {#if peerStatus.profile}
        <span class="sr-only">{peerStatus.profile.handle}</span>
      {:else}
        <span class="sr-only">Log in</span>
      {/if}
    </button>
  {/snippet}

  <div class="flex flex-col">
    {#if connected}
      <div class="border-b border-base-300 pb-4 mb-2 flex items-center gap-2">
        <Avatar
          src={peerStatus.profile?.avatar}
          fallback={peerStatus.profile?.displayName}
          class="group-hover:scale-110 transition-transform duration-200"
        ></Avatar><a
          class="mr-auto font-medium truncate"
          title={`@${peerStatus.profile?.handle}`}
          href={"/user/" + peerStatus.profile?.id}
          >@{peerStatus.profile?.handle}</a
        >
        <Button variant="ghost" class="" onclick={handleLogout}>Log Out</Button>
      </div>
    {/if}

    <ThemeSettings />
  </div>
</Popover>
