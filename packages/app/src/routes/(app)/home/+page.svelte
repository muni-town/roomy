<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";

  import { globalState } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { AccountCoState } from "jazz-svelte";
  import { AccountSchema } from "$lib/schema";

  const account = new AccountCoState(AccountSchema, {
    resolve: {
      profile: true,
    },
  });
  const me = $derived(account.current);
  let spaces = $derived(globalState.catalog?.spaces);
</script>

<div class="dz-hero bg-base-200 min-h-screen">
  <div class="dz-hero-content">
    <div class="flex flex-col gap-8 items-center">
      <h1 class="text-5xl font-bold text-center">Hi Roomy 👋</h1>
      <p class="text-lg font-medium max-w-2xl text-center">
        A digital gardening platform for communities. Flourish in Spaces,
        curating knowledge and conversations together.
      </p>
      <div>Hello {me?.profile.name}!</div>
      <div class="divider"></div>

      {#if !user.session}
        <div class="flex gap-4">
          <Button.Root
            onclick={() => (user.isLoginDialogOpen = true)}
            class="dz-btn dz-btn-primary"
          >
            Create Account or Log In
          </Button.Root>
        </div>
      {:else if !spaces}
        <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
      {:else if spaces.length > 0}
        <h2 class="text-3xl font-bold">Your Spaces</h2>
        <section class="flex flex-wrap justify-center gap-4 max-w-5xl">
          {#each spaces as space}
            <a
              href={`/${space?.id}`}
              class="dz-card border border-base-300 hover:border-primary bg-base-100 transition-colors cursor-pointer text-base-content w-full md:w-96"
            >
              <div class="dz-card-body flex-row items-center justify-between">
                <h2 class="dz-card-title">{space?.name}</h2>
                <div class="dz-card-actions">
                  <Icon
                    icon="lucide:circle-arrow-right"
                    class="text-2xl text-primary"
                  />
                </div>
              </div>
            </a>
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
</div>
