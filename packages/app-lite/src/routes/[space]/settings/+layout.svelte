<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setSpaceInfo, navbar } from "$lib/components/layout/navbar.svelte";
  import { settingsBar } from "$lib/components/layout/settings-bar.svelte";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconSettings } from "@roomy/design/icons";
  import { currentSpaceState } from "$lib/components/layout/current-space.svelte";
  import { resolveBlobUrl } from "$lib/utils";

  let { children } = $props();

  const currentSpace = $derived(currentSpaceState.value);

  // Derive the active settings page name from the route so the navbar shows
  // "General", "Roles", "Members", etc. instead of a static "Space settings".
  const settingsPageName = $derived.by(() => {
    const parts = page.url.pathname.split("/");
    const idx = parts.indexOf("settings");
    if (idx === -1 || idx === parts.length - 1) return "General";
    switch (parts[idx + 1]) {
      case "roles":
        return "Roles";
      case "members":
        return "Members";
      case "invites":
        return "Invites";
      case "discord-bridge":
        return "Discord Bridge";
      case "handle":
        return "Handle";
      default:
        return "Settings";
    }
  });

  // While a settings route is mounted, open the settings panel — it slides
  // in from the right within the unified sidebar (the SpaceSidebar stays in
  // place; only its channels body slides out). This auto-opens the panel on
  // deep links to `/.../settings/...` (and on refresh, where `onNavigate`
  // doesn't fire). The settings button is a pure toggle that can close it
  // without navigating; leaving the settings routes is handled centrally in
  // the root `onNavigate`, so this cleanup only restores the navbar.
  onMount(() => {
    setSpaceInfo(settingsSpaceInfo);
    settingsBar.expanded = true;
    return () => {
      setSpaceInfo(undefined);
    };
  });
</script>

{#snippet settingsSpaceInfo()}
  <div class="flex items-center gap-2 ml-4 sm:ml-2 min-w-0">
    <!-- Space context (avatar): mobile-only, mirroring NavbarSpaceInfo. On
         desktop the sidebar already shows the space header. -->
    {#if currentSpace}
      <span class="sm:hidden shrink-0">
        <SpaceAvatar
          src={resolveBlobUrl(currentSpace.avatar)}
          id={currentSpace.id}
          name={currentSpace.name ?? undefined}
          size={24}
        />
      </span>
    {/if}
    <span class="text-base-300 dark:text-base-700 shrink-0 sm:hidden">/</span>
    <IconSettings class="size-4 shrink-0 text-base-500" />
    <span
      class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
    >
      {settingsPageName}
    </span>
    {#if navbar.spaceInfoExtra}
      <span class="flex items-center gap-1.5 shrink-0">
        {@render navbar.spaceInfoExtra?.()}
      </span>
    {/if}
  </div>
{/snippet}

<ScrollArea class="h-full">
  <div class="max-w-3xl mx-auto w-full p-4">
    {@render children()}
  </div>
</ScrollArea>