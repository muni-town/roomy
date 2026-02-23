<script lang="ts">
  import { ScrollArea } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { page } from "$app/state";

  let { children } = $props();

  const links: { label: string; href: string }[] = [
    {
      label: "PDS",
      href: "/admin/pds",
    },
  ];
</script>

<MainLayout>
  {#snippet navbar()}
    <h1 class="text-xl font-bold ml-3">Roomy Admin</h1>
  {/snippet}
  {#snippet sidebar()}
    <div class="px-2 flex flex-col gap-2 py-8">
      {#each links as { href, label }}
        <Button
          variant="ghost"
          class="w-full justify-start"
          {href}
          data-current={page.url.pathname.includes(href)}>{label}</Button
        >
      {/each}
      <!-- <Button
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
      > -->
    </div>
  {/snippet}

  <ScrollArea
    class="flex flex-col gap-4 px-4 py-4 overflow-y-scroll text-base-900 dark:text-base-100"
  >
    {@render children?.()}
  </ScrollArea>
</MainLayout>
