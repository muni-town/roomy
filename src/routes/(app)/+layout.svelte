<script lang="ts">
  import "../../app.css";
  import { onMount, setContext } from "svelte";
  import { dev } from "$app/environment";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";

  let { children } = $props();
  import SpacesColumn from "$lib/components/SpacesColumn.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import RoomSidebar from "$lib/components/RoomSidebar.svelte";

  onMount(async () => {
    await user.init();
  });

  const spaces = derivePromise(
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
<div
  class="drawer sm:drawer-open {!page.params.space
    ? 'drawer-open'
    : ''} flex gap-0 w-screen h-screen bg-base-300 max-h-screen overflow-clip"
>
  <Toaster />
  <input id="my-drawer-4" type="checkbox" class="drawer-toggle" />
  <div class="drawer-side z-10 max-h-screen shrink-0">
    <label
      for="my-drawer-4"
      aria-label="close sidebar"
      class="drawer-overlay opacity-0"
    ></label>
    <div class="flex h-full max-h-full gap-0 overflow-x-clip sm:w-fit">
      <SpacesColumn
        {spaces}
        visible={isSpacesVisible.value || !page.params.space}
      />
      {#if page.params.space}
        <RoomSidebar />
      {/if}
    </div>
  </div>
  {@render children()}
</div>
