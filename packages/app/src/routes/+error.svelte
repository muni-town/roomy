<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Button } from "@fuxui/base";

  onMount(() => {
    console.error(page.status, page.error, page.error?.message);
  });
</script>

<div class="flex items-center justify-center min-h-screen px-4">
  <div>
    <div class="flex flex-col gap-8 items-center">
      <h1
        class="text-5xl font-bold text-center text-base-900 dark:text-base-100"
      >
        Something went wrong
      </h1>
      <p
        class="text-lg font-medium max-w-2xl text-center text-base-700 dark:text-base-300"
      >
        The page you are looking for could not be found.
      </p>
      <Button onclick={() => goto("/home")} size="lg">Go back Home</Button>
    </div>
  </div>
</div>
