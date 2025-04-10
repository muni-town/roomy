<script lang="ts">
  import "../../app.css";
  import { onMount, setContext } from "svelte";
  import { dev } from "$app/environment";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";

  let { children } = $props();
  import { outerWidth } from "svelte/reactivity/window";
  import SpaceBar from "$lib/components/SpaceBar.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { page } from "$app/state";

  let isMobile = $derived((outerWidth.current || 0) < 640);
  onMount(async () => {
    await user.init();
  });

  let spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );
  const Toggle = (init = false) => {
    let value = $state(init);
    return {
      get value() {
        return value;
      },
      toggle() {
        value = !value;
      },
    };
  };
  const isSpacesVisible = Toggle(false);
  setContext("isSpacesVisible", isSpacesVisible);
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
  <SpaceBar {spaces} visible={isSpacesVisible.value || !page.params.space} />
  {@render children()}
</div>
