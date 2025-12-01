<script lang="ts">
  import { Avatar, Tooltip } from "@fuxui/base";
  import UserSettingsModal from "../modals/UserSettingsModal.svelte";
  import { backendStatus } from "$lib/workers";

  let userSettingsModalOpen = $state(false);

  const connected = $derived(
    backendStatus.authState?.state === "authenticated",
  );
</script>

<Tooltip
  text={connected ? "Connected" : "Disconnected"}
  contentProps={{ side: "right" }}
>
  {#snippet child({ props })}
    <div
      {...props}
      class="border-2 border-solid rounded-full flex"
      class:border-green-500={connected}
      class:border-red-500={!connected}
    >
      <button
        onclick={() => {
          if (connected) {
            userSettingsModalOpen = true;
          }
          //  else {
          //   blueskyLoginModalState.open = true;
          // }
        }}
        class="cursor-pointer opacity-90 hover:opacity-100 transition-opacity duration-200 group overflow-hidden rounded-full size-10"
      >
        <Avatar
          src={backendStatus.profile?.avatar}
          fallback={backendStatus.profile?.displayName}
          class="group-hover:scale-110 transition-transform duration-200"
        ></Avatar>
        {#if backendStatus.profile}
          <span class="sr-only">{backendStatus.profile.handle}</span>
        {:else}
          <span class="sr-only">Log in</span>
        {/if}
      </button>
    </div>
  {/snippet}
</Tooltip>

<UserSettingsModal bind:open={userSettingsModalOpen} />
