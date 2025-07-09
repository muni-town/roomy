<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { AccountCoState } from "jazz-svelte";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import { Button } from "@fuxui/base";
  import { blueskyLoginModalState } from "@fuxui/social";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SpaceButton from "$lib/components/SpaceButton.svelte";

  const account = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: {
          $each: true,
          $onError: null,
        },
      },
    },
  });
  const me = $derived(account.current);
  let spaces = $derived(me?.profile?.joinedSpaces);

  $inspect(spaces);
</script>

<MainLayout>
  <div
    class="flex flex-col items-center justify-start py-8 overflow-y-auto"
  >
      <div class="flex flex-col gap-8 items-center">
        <h1
          class="text-5xl font-bold text-center text-base-950 dark:text-base-50"
        >
          Hi Roomy 👋
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center">
          A digital gardening platform for communities. Flourish in Spaces,
          curating knowledge and conversations together.
        </p>
        <div class="divider"></div>

        {#if !user.session}
          <div class="flex gap-4">
            <Button
              onclick={() => (blueskyLoginModalState.open = true)}
              size="lg"
            >
              Create Account or Log In
            </Button>
          </div>
        {:else if !spaces}
          <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
        {:else if spaces.length > 0}
          <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
            Your Spaces
          </h2>
          <section class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-8 max-w-5xl">
            {#each spaces as space}
              <SpaceButton space={space} />
            {/each}
          </section>
        {:else if spaces?.length === 0}
          <p class="text-lg font-medium text-center">
            You don't have any spaces yet. Create one to get started!
          </p>
        {:else}
          <p>No servers found.</p>
        {/if}
      </div>
  </div>
</MainLayout>
