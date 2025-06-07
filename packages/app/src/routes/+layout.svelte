<script lang="ts">
  import "../app.css";
  import { JazzProvider } from "jazz-svelte";
  import { RoomyAccount } from "$lib/jazz/schema";
  import "jazz-inspector-element";
  import { dev } from "$app/environment";

  const peerUrl = "wss://cloud.jazz.tools/?key=nandithebull@outlook.com";
  let sync = { peer: peerUrl, when: "always" };

  let { children } = $props();
</script>

<svelte:head>
  {#if dev}
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👷‍♀️</text></svg>"
    />
  {/if}
</svelte:head>

<JazzProvider {sync} AccountSchema={RoomyAccount}>
  <jazz-inspector></jazz-inspector>
  {@render children?.()}
</JazzProvider>
