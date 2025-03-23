<script lang="ts">
  import { g } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";

  let spaces = derivePromise(
    undefined,
    async () => await g.roomy?.spaces.items(),
  );
</script>

<header class="hero bg-base-200 min-h-screen">
  <div class="hero-content">
    <div class="flex flex-col gap-8 items-center">
      <h1 class="text-5xl font-bold">Hello Roomy</h1>
      <p class="text-lg font-medium max-w-2xl text-center">
        A digital gardening platform for communities. Built on the AT Protocol.
        Flourish in Spaces, curating knowledge and conversations together.
      </p>
      <div class="divider"></div>

      {#if !spaces.value}
        <span class="loading loading-spinner mx-auto w-25"></span>
      {:else if spaces.value.length > 0}
        <h2 class="text-3xl font-bold">Your Spaces</h2>
        <section class="flex gap-4 flex-wrap justify-center max-w-5xl">
          {#each spaces.value as space}
            <div class="card card-dash bg-base-100 w-96">
              <div class="card-body">
                <h2 class="card-title">{space.name}</h2>
                <div class="card-actions justify-end">
                  <a
                    href={`/${space.handles.get(0) || space.id}`}
                    class="btn btn-primary">Open Space</a
                  >
                </div>
              </div>
            </div>
          {/each}
        </section>
      {:else}
        <p>No servers found.</p>
      {/if}
    </div>
  </div>
</header>
