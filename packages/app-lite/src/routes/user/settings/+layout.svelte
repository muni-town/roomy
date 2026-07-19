<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setSpaceInfo } from "$lib/components/layout/navbar.svelte";
  import { setSidebar, setSidebarHeader } from "$lib/components/layout/sidebar.svelte";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconArrowLeft, IconSettings } from "@roomy/design/icons";
  import RoomyMark from "$lib/components/RoomyMark.svelte";

  let { children } = $props();

  // Derive the active settings page name from the route so the navbar shows
  // "General" or "Notifications" instead of a static "User settings".
  const settingsPageName = $derived.by(() => {
    const parts = page.url.pathname.split("/");
    const idx = parts.indexOf("settings");
    if (idx === -1 || idx === parts.length - 1) return "General";
    switch (parts[idx + 1]) {
      case "notifications":
        return "Notifications";
      default:
        return "Settings";
    }
  });

  onMount(() => {
    setSpaceInfo(settingsSpaceInfo);
    setSidebar(settingsSidebar);
    setSidebarHeader(settingsSidebarHeader);
    return () => {
      setSpaceInfo(undefined);
      setSidebar(undefined);
      setSidebarHeader(undefined);
    };
  });
</script>

{#snippet settingsSpaceInfo()}
  <div class="flex items-center gap-2 ml-4 sm:ml-2 min-w-0">
    <IconSettings class="size-4 shrink-0 text-base-500" />
    <span
      class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
    >
      {settingsPageName}
    </span>
  </div>
{/snippet}

{#snippet settingsSidebarHeader()}
  <div class="w-full h-fit flex justify-between items-center gap-1">
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <div class="flex items-center gap-2.75 -mx-1 px-5.5 py-3">
        <RoomyMark sizeClass="size-8" />
        <h1
          class="text-lg font-black opacity-90 text-base-700 dark:text-base-200 truncate max-w-full grow min-w-0"
        >
          Roomy
        </h1>
      </div>
    </div>
  </div>
{/snippet}

{#snippet settingsSidebar()}
  <div class="flex flex-col h-full">
    <div class="p-3">
      <Button class="w-full justify-start" href="/" variant="ghost">
        <IconArrowLeft class="size-4" />
        Back to home
      </Button>
    </div>
    <div class="flex flex-col gap-1 px-3">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500 px-2">
        Settings
      </span>
      <Button
        variant="ghost"
        class="w-full justify-start"
        href="/user/settings"
        data-current={page.url.pathname === "/user/settings"}
      >
        General
      </Button>
      <Button
        variant="ghost"
        class="w-full justify-start"
        href="/user/settings/notifications"
        data-current={page.url.pathname === "/user/settings/notifications"}
      >
        Notifications
      </Button>
    </div>
  </div>
{/snippet}

<ScrollArea class="h-full">
  <div class="max-w-3xl mx-auto w-full p-4">
    {@render children()}
  </div>
</ScrollArea>
