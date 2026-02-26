<script lang="ts">
  import { page } from "$app/state";
  import { Box } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";

  let { message }: { message?: string } = $props();

  const handle = $derived(page.params.space);
</script>

<div class="flex items-center justify-center h-screen w-full">
  <Box class="w-[28em] flex flex-col items-center gap-4 p-8">
    <div class="text-4xl">:(</div>
    <h2 class="text-lg font-semibold">Space not found</h2>
    {#if handle}
      <p class="text-sm text-base-500 dark:text-base-400 text-center">
        We couldn't find a space at <span
          class="font-mono bg-base-200 dark:bg-base-800 px-1.5 py-0.5 rounded"
          >{handle}</span
        >
      </p>
    {/if}
    {#if message}
      <p class="text-xs text-base-400 dark:text-base-500 text-center">
        {message}
      </p>
    {/if}
    <div
      class="text-sm text-base-500 dark:text-base-400 text-center space-y-1"
    >
      <p>This could mean:</p>
      <ul class="text-left list-disc list-inside">
        <li>The space doesn't exist yet</li>
        <li>The handle hasn't been linked to a space</li>
        <li>The URL may be incorrect</li>
      </ul>
    </div>
    <a href="/home" class="mt-2">
      <Button variant="blue">Go Home</Button>
    </a>
  </Box>
</div>
