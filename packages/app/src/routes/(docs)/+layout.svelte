<script lang="ts">
  import "../../app.css";
  import { dev } from "$app/environment";
  import Navbar from "$lib/components/layout/Navbar.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { Prose, ScrollArea } from "@foxui/core";

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

<div class="flex flex-col items-center justify-stretch max-h-[100vh]">
  <Navbar class="gap-2">
    <h1 class="text-xl font-bold">Roomy Space Terms of Service</h1>
    <span class="flex-grow"></span>
    <Button href="/">App</Button>
    <Button href="https://a.roomy.space">About</Button>
  </Navbar>
  <ScrollArea class="w-full flex flex-col items-center">
    <Prose class="max-w-[50em] my-10 px-5">
      {@render children()}
    </Prose>
  </ScrollArea>
</div>
