<script lang="ts">
  import { g } from "$lib/global.svelte";

  let servers: string[] = $derived(
    g.catalog?.view.spaces.map((x) => x.id) || [],
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

      {#if servers.length > 0}
        <h2 class="text-3xl font-bold">Your Spaces</h2>
        <section class="flex gap-4 flex-wrap justify-center max-w-5xl">
          {#each servers as server}
            {@const space = g.spaces[server]}
            {#if space}
              <div class="card card-dash bg-base-100 w-96">
                <div class="card-body">
                  <h2 class="card-title">{space.view.name}</h2>
                  <div class="card-actions justify-end">
                    <a href={`/space/${server}`} class="btn btn-primary">Join Space</a>
                  </div>
                </div>
              </div>
            {/if}
          {/each}
        </section>
      {:else}
        <p>No servers found.</p>
      {/if}
    </div>
  </div>

</header>
