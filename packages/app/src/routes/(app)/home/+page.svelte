<script lang="ts">
  import Button from "$lib/components/ui/button/Button.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SpaceButton from "$lib/components/spaces/SpaceButton.svelte";
  import EarlyAlphaWarning from "$lib/components/helper/EarlyAlphaWarning.svelte";
  import { getAppState } from "$lib/queries";
  import { peer } from "$lib/workers";

  const app = getAppState();

  import { IconPlus } from "@roomy/design/icons";

  $effect(() => {
    peer.setCurrentSpace(undefined);
  });
</script>

<MainLayout>
  {#snippet navbar()}
    <div class="flex w-full items-center gap-3">
      <span class="grow"></span>
      <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
    </div>
  {/snippet}
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

      <!-- {#if publicDemoSpaces.length > 0}
        <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
          Public Demo Spaces
        </h2>
        <section class="flex flex-row gap-8 max-w-5xl">
          {#each publicDemoSpaces as space}
            <SpaceButton {space} />
          {/each}
        </section>
      {/if} -->

      <Button href="/new" class="gap-2">
        <IconPlus />
        Create Space
      </Button>

      {#if app.spaces.length || 0 > 0}
        <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
          Your Spaces
        </h2>
        <section
          class="flex flex-row gap-8 mx-8 justify-center flex-wrap max-w-5xl"
        >
          {#each app.spaces as space}
            <SpaceButton {space} />
          {/each}
        </section>
      {:else if app.spaces.length || 0 == 0}
        <p class="text-lg font-medium text-center">
          You don't have any spaces yet. Create one to get started!
        </p>
      {:else}
        <p>No servers found.</p>
      {/if}
    </div>
  </div>
</MainLayout>
