<script lang="ts">
  import "../../app.css";
  import { onMount, setContext } from "svelte";
  import { browser, dev } from "$app/environment";

  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";

  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { derivePromise, Toggle } from "$lib/utils.svelte";
  import ServerBar from "$lib/components/ServerBar.svelte";

  const { children } = $props();
  const spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );

  onMount(async () => {
    await user.init();

    if (!dev && browser) {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://roomy.chat/ingest",
        person_profiles: "identified_only", // or 'always' to create profiles for anonymous users as well
      });
    }
  });

  const isSpacesVisible = Toggle({ value: false, key: "isSpacesVisible" });
  setContext("isSpacesVisible", isSpacesVisible);

  let themeColor = $state({
    value:
      getComputedStyle(document.querySelector("html")).getPropertyValue(
        "--color-base-300",
      ) ?? "#e6ddac",
  });
  $inspect(themeColor);
  setContext("themeColor", themeColor);
</script>

<svelte:head>
  <meta name="theme-color" content={themeColor.value} />
  <meta name="msapplication-navbutton-color" content={themeColor.value} />
  <meta name="msapplication-TileColor" content={themeColor.value} />
  <title>Roomy</title>
</svelte:head>

{#if dev}
  <RenderScan />
{/if}

<!-- Container -->
<div class="flex w-screen h-screen bg-base-100">
  <Toaster />
  <ServerBar {spaces} visible={isSpacesVisible.value || !page.params.space} />

  {@render children()}
</div>
