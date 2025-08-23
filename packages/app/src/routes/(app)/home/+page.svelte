<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { AccountCoState } from "jazz-tools/svelte";
  import { co, RoomyAccount, RoomyEntity } from "@roomy-chat/sdk";
  import { Button } from "@fuxui/base";
  import { blueskyLoginModalState } from "@fuxui/social";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SpaceButton from "$lib/components/spaces/SpaceButton.svelte";
  import EarlyAlphaWarning from "$lib/components/helper/EarlyAlphaWarning.svelte";
  import { onMount } from "svelte";

  const account = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
    },
  });
  const me = $derived(account.current);
  let spaces = $derived(me?.profile?.joinedSpaces);

  // FIXME: hardcode the muni and spicy demo spaces in.
  let publicSpaceIds = [
    "co_zgr1XyZyG3MHjswMoep5Na2eKr9",
    "co_zGrLp9i59rcFeZCoW9KjULCbPkg",
  ];
  let publicDemoSpaces = $state([]) as co.loaded<typeof RoomyEntity>[];
  onMount(() => {
    for (const id of publicSpaceIds) {
      RoomyEntity.load(id).then((s) => s && publicDemoSpaces.push(s));
    }
  });
</script>

<MainLayout>
  <div
    class="flex flex-col items-center justify-start py-8 overflow-y-auto px-4"
  >
    <div class="flex flex-col gap-8 items-center">
      <h1
        class="text-5xl font-bold text-center text-base-950 dark:text-base-50"
      >
        Hi Roomy 👋
      </h1>
      <p class="text-lg font-medium max-w-2xl text-center text-pretty">
        A digital gardening platform for communities. Flourish in Spaces,
        curating knowledge and conversations together.
      </p>

      <EarlyAlphaWarning />

      <div class="divider"></div>

      {#if publicDemoSpaces.length > 0}
        <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
          Public Demo Spaces
        </h2>
        <section
          class="flex flex-row gap-8 max-w-5xl"
        >
          {#each publicDemoSpaces as space}
            <SpaceButton {space} />
          {/each}
        </section>
      {/if}

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
        <section
          class="flex flex-row gap-8 max-w-5xl"
        >
          {#each new Set(spaces.toReversed()) as space}
            {#if !publicDemoSpaces.find((x) => x.id == space?.id)}
              <SpaceButton {space} />
            {/if}
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
