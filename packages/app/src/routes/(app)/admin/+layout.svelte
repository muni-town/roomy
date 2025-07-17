<script lang="ts">
  import { Button, ScrollArea } from "@fuxui/base";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";

  let { children } = $props();

  onMount(() => {
    goto("/admin/spaces");
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <div class="px-2 flex flex-col gap-2 py-8">
      <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/admin/spaces`}
        data-current={page.url.pathname.includes("spaces")}>Spaces</Button
      >
      <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/admin/accounts`}
        data-current={page.url.pathname.includes("accounts")}>Accounts</Button
      >
      <Button
        variant="ghost"
        class="w-full justify-start"
        href={`/admin/stats`}
        data-current={page.url.pathname.includes("stats")}>Stats</Button
      >
    </div>
  {/snippet}

  <ScrollArea
    class="flex flex-col gap-4 px-4 py-12 overflow-y-scroll text-base-900 dark:text-base-100"
  >
    <div class="max-w-4xl mx-auto w-full">
      {@render children?.()}
    </div>
  </ScrollArea>
</MainLayout>
