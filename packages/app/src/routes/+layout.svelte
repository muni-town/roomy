<script lang="ts">
  import "../app.css";
  import { JazzProvider } from "jazz-svelte";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import "jazz-inspector-element";
  import { dev } from "$app/environment";
  import { BlueskyLoginModal } from "@fuxui/social";
  import { user } from "$lib/user.svelte";

  const peerUrl =
    "wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com" as `wss://${string}`;
  let sync = { peer: peerUrl, when: "always" as const };

  let { children } = $props();
</script>

<svelte:head>
  {#if dev}
    <!-- replaces favicon on dev, to easily spot difference between deployed and dev versions -->
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

<BlueskyLoginModal
  login={async (handle: string) => {
    await user.loginWithHandle(handle);
    return true;
  }}
/>
