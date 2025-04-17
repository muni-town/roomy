<script lang="ts">
  import "../../app.css";
  import { browser, dev } from "$app/environment";
  
  import { onMount, setContext } from "svelte";
  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { Button, ToggleGroup } from "bits-ui";
  
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";

  let { children } = $props();
  import SpacesColumn from "$lib/components/SpacesColumn.svelte";
  import { derivePromise, Toggle } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import RoomSidebar from "$lib/components/RoomSidebar.svelte";

  onMount(async () => {
    await user.init();
  });

  const spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );

  const isSpacesVisible = Toggle({ value: false, key: "isSpacesVisible" });
  setContext("isSpacesVisible", isSpacesVisible);
  
  onMount(async () => {
    await user.init();

    if (!dev && browser) {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only", // or 'always' to create profiles for anonymous users as well
      });
    }
  });

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
  <input id="sidebar-left" type="checkbox" class="drawer-toggle" />
  <div class="drawer-side z-10 max-h-screen shrink-0">
    <label
      for="sidebar-left"
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
