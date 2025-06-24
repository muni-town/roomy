<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { JazzProvider } from "jazz-svelte";
  import { Toaster } from "svelte-french-toast";  import { user } from "$lib/user.svelte";
  import { RoomyAccount } from "$lib/jazz/schema";
  import JazzAccountProvider from "$lib/components/JazzAccountProvider.svelte";
  
  let { children } = $props();

  const peerUrl = "wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com" as `wss://${string}`;
  let sync = { peer: peerUrl, when: "always" as const };
  onMount(async () => {
    await user.init();
  });
</script>

<svelte:head>
  <title>Discord Bridge - Roomy</title>
  <meta name="description" content="Bridge between Discord and Roomy" />
</svelte:head>

<JazzProvider {sync} AccountSchema={RoomyAccount}>
  <JazzAccountProvider>
    <Toaster />
    {@render children?.()}
  </JazzAccountProvider>
</JazzProvider>
