<script lang="ts">
  import { Alert } from "$lib/components/ui/alert";
  import Button from "$lib/components/ui/button/Button.svelte";
  import type { Snippet } from "svelte";

  let {
    message,
    children,
    goHome,
    tellUs = true,
  } = $props<{
    message?: string;
    children?: Snippet;
    goHome?: boolean;
    tellUs?: boolean;
  }>();
</script>

<div class="w-full h-screen flex items-center justify-center">
  <Alert title="Something went wrong :(" class="max-w-sm">
    {#if children}
      {@render children()}
    {:else if message}
      <h6 class="mb-2 max-w-full text-ellipsis overflow-hidden">{message}</h6>
    {/if}
    {#if tellUs}
      <span
        >You can let us know on <a
          href="https://github.com/muni-town/roomy/issues/new"
          class="text-accent-600 dark:text-accent-200">Github</a
        >,
        <a
          href="https://discord.gg/bGMESxp7ff"
          class="text-accent-600 dark:text-accent-200">Discord</a
        >
        or
        <a
          href="https://bsky.app/profile/roomy.space"
          class="text-accent-600 dark:text-accent-200">Bluesky</a
        ></span
      >
    {/if}
    {#if goHome}
      <div class="flex w-full mt-2 justify-center">
        <a href="/"
          ><Button variant="blue" class="bg-blue-50">Go Home</Button></a
        >
      </div>
    {/if}
  </Alert>
</div>
