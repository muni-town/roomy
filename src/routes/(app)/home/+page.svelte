<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";

  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { derivePromise } from "$lib/utils.svelte";

  const spaces = derivePromise(
    undefined,
    async () => await g.roomy?.spaces.items(),
  );
</script>

<div class="dz-hero bg-base-200 min-h-screen">
  <div class="dz-hero-content">
    <div class="flex flex-col gap-8 items-center">
      <h1 class="text-5xl font-bold text-center">Hello Roomy</h1>
      <p class="text-lg font-medium max-w-2xl text-center">
        A digital gardening platform for communities. Built on the AT Protocol.
        Flourish in Spaces, curating knowledge and conversations together.
      </p>
      <div class="divider"></div>

      {#if !user.session}
        <Button.Root
          onclick={() => (user.isLoginDialogOpen = true)}
          class="dz-btn dz-btn-primary"
        >
          Log In with Bluesky
        </Button.Root>
      {:else if !spaces.value}
        <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
      {:else if spaces.value.length > 0}
        <h2 class="text-3xl font-bold">Your Spaces</h2>
        <section class="flex flex-wrap justify-center gap-4 max-w-5xl">
          {#each spaces.value as space}
            <a
              href={`/${space.handles((x) => x.get(0)) || space.id}`}
              class="card border border-base-300 hover:border-primary bg-base-100 transition-colors cursor-pointer text-base-content w-full md:w-96"
            >
              <div class="card-body flex-row items-center justify-between">
                <h2 class="card-title">{space.name}</h2>
                <div class="card-actions">
                  <Icon
                    icon="lucide:circle-arrow-right"
                    class="text-2xl text-primary"
                  />
                </div>
              </div>
            </a>
          {/each}
        </section>
      {:else if spaces.value.length === 0}
        <p class="text-lg font-medium text-center">
          You don't have any spaces yet. Create one to get started!
        </p>
      {:else}
        <p>No servers found.</p>
      {/if}
    </div>
  </div>
</div>
