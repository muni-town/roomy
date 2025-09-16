<script lang="ts">
  import { Avatar } from "@fuxui/base";
  import UserSettingsModal from "../modals/UserSettingsModal.svelte";
  import { backendStatus } from "$lib/workers";

  let userSettingsModalOpen = $state(false);
</script>

<button
  onclick={() => {
    if (backendStatus.did) {
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
    fallback={backendStatus.did}
    class="group-hover:scale-110 transition-transform duration-200"
  ></Avatar>
  {#if backendStatus.profile}
    <span class="sr-only">{backendStatus.profile.handle}</span>
  {:else}
    <span class="sr-only">Log in</span>
  {/if}
</button>

<UserSettingsModal bind:open={userSettingsModalOpen} />
