<script lang="ts">
  import "../../app.css";
  import { onMount } from "svelte";
  import { dev } from "$app/environment";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { page } from "$app/state";

  let { children } = $props();
  import { outerWidth } from "svelte/reactivity/window";
  import SpaceBar from "$lib/components/SpaceBar.svelte";
  import { derivePromise } from "$lib/utils.svelte";

  let isMobile = $derived((outerWidth.current || 0) < 640);
  onMount(async () => {
    await user.init();
  });

  let spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );


</script>

<svelte:head>
  <title>Roomy</title>
</svelte:head>

{#if dev}
  <RenderScan />
{/if}

<!-- Container -->
<div class="flex gap-0 w-screen h-screen bg-base-300">
  <Toaster />
  <SpaceBar {spaces} />
  {@render children()}
</div>
