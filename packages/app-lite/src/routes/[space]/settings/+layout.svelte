<script lang="ts">
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebar } from "$lib/components/layout/sidebar.svelte";
  import SettingsSidebar from "$lib/components/sidebar/SettingsSidebar.svelte";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";

  let { children } = $props();
  const spaceId = $derived(page.params.space!);

  $effect(() => {
    setNavbar(settingsNavbar);
    setSidebar(settingsSidebar);
    return () => {
      setNavbar(undefined);
      setSidebar(undefined);
    };
  });
</script>

{#snippet settingsNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Space settings
  </div>
{/snippet}

{#snippet settingsSidebar()}
  <SettingsSidebar {spaceId} />
{/snippet}

<ScrollArea class="h-full">
  <div class="max-w-3xl mx-auto w-full p-4">
    {@render children()}
  </div>
</ScrollArea>
