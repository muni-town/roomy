<script lang="ts">
  import "../app.css";
  import { JazzProvider } from "jazz-svelte";
  import { RoomyAccount } from "$lib/jazz/schema";
  import "jazz-inspector-element";

  const peerUrl = "wss://cloud.jazz.tools/?key=nandithebull@outlook.com";
  let sync = { peer: peerUrl, when: "always" };

  let { children } = $props();
</script>

<JazzProvider {sync} AccountSchema={RoomyAccount}>
  <jazz-inspector></jazz-inspector>
  {@render children?.()}
</JazzProvider>
