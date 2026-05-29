<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SpaceButton from "$lib/components/spaces/SpaceButton.svelte";
  import EarlyAlphaWarning from "@roomy/design/components/helper/EarlyAlphaWarning.svelte";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { getAppState } from "$lib/queries";
  import { joinSpace } from "$lib/mutations/space";
  import { peer } from "$lib/workers";

  const app = getAppState();

  import { IconPlus } from "@roomy/design/icons";

  let rejoining = $state<string | null>(null);

  async function rejoin(spaceId: string) {
    rejoining = spaceId;
    try {
      await joinSpace(spaceId as any);
    } catch (e) {
      console.error("Failed to rejoin space", e);
    } finally {
      rejoining = null;
    }
  }

  $effect(() => {
    peer.setCurrentSpace(undefined);
  });
</script>

<MainLayout>
  {#snippet navbar()}
    <div class="flex w-full items-center gap-3">
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

      <Button variant="secondary" class="gap-2">Not now</Button>

      {#if app.spaces.length || 0 > 0}
        <h2
          class="text-3xl font-bold text-base-900 dark:text-base-100 translate-0.5"
        >
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

      {#if app.leftSpaces.length > 0}
        <div class="divider"></div>
        <details class="w-full max-w-5xl px-8">
          <summary
            class="font-medium text-sm text-center opacity-70 cursor-pointer select-none hover:text-base-700 dark:hover:text-base-300 transition-colors"
          >
            Left Spaces ({app.leftSpaces.length})
          </summary>
          <section class="flex flex-row gap-6 mt-4 justify-center flex-wrap">
            {#each app.leftSpaces as space}
              <div
                class="flex flex-col items-center gap-2 w-32 opacity-60 hover:opacity-100 transition-opacity"
              >
                <SpaceAvatar
                  imageUrl={space.avatar}
                  id={space.id}
                  name={space.name}
                  size={64}
                />
                <span
                  class="text-sm font-medium text-center text-base-700 dark:text-base-300 line-clamp-2"
                >
                  {space.name || "Unnamed Space"}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => rejoin(space.id)}
                  disabled={rejoining === space.id}
                >
                  {rejoining === space.id ? "Joining…" : "Rejoin"}
                </Button>
              </div>
            {/each}
          </section>
        </details>
      {/if}
    </div>
  </div>
</MainLayout>
