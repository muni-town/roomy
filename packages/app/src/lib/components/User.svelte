<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { Avatar } from "@fuxui/base";
  import { blueskyLoginModalState } from "@fuxui/social";
  import UserSettingsModal from "./modals/UserSettingsModal.svelte";

  let userSettingsModalOpen = $state(false);
</script>

<button
  onclick={() => {
    if (user.session) {
      userSettingsModalOpen = true;
    } else {
      blueskyLoginModalState.open = true;
    }
  }}
  class="cursor-pointer"
>
  <Avatar src={user.profile.data?.avatar} fallback={user.profile.data?.handle}
  ></Avatar>
  {#if user.session}
    <span class="sr-only">{user.profile.data?.handle}</span>
  {:else}
    <span class="sr-only">Log in</span>
  {/if}
</button>

<UserSettingsModal bind:open={userSettingsModalOpen} />
