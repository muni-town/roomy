<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { goto, onNavigate } from "$app/navigation";
  import BigSidebar from "@roomy/design/components/layout/BigSidebar.svelte";
  import RoomyHomeCard from "$lib/components/sidebar/RoomyHomeCard.svelte";
  import SidebarUserCard from "$lib/components/sidebar/SidebarUserCard.svelte";
  import Navbar from "@roomy/design/components/layout/Navbar.svelte";
  import ToggleNavigation from "@roomy/design/components/helper/ToggleNavigation.svelte";
  import { navbar } from "./navbar.svelte";
  import { sidebarOverride, sidebarContent } from "./sidebar.svelte";
  import { mobileSidebar } from "./mobile-sidebar.svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import SyncStatusBanner from "./SyncStatusBanner.svelte";

  let {
    children,
    chatArea = false,
  }: {
    children: Snippet;
    chatArea?: boolean;
  } = $props();

  // Compact mode when on a space page or other inner route (not the root homepage)
  const compact = $derived(page.route.id !== "/");

  const sidebar = $derived(sidebarOverride.content ?? sidebarContent.content);

  onNavigate(() => {
    mobileSidebar.visible = false;
  });
</script>

<!-- Main panel: navbar + page content, offset to clear the fixed sidebar -->
<div
  class={[
    "h-full flex flex-col overflow-hidden sm:ml-64",
    chatArea ? "bg-white dark:bg-base-950" : "",
  ]}
>
  <Navbar {compact}>
    <div class="flex gap-4 items-center mr-auto ml-2 sm:hidden">
      <ToggleNavigation bind:isSidebarVisible={mobileSidebar.visible} />
    </div>

    {#if compact && currentSpaceState.value}
      <div class="flex items-center gap-2 ml-2 sm:ml-0">
        <SpaceAvatar
          src={resolveBlobUrl(currentSpaceState.value.avatar)}
          id={currentSpaceState.value.id}
          name={currentSpaceState.value.name ?? undefined}
          size={24}
        />
        <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate max-w-40">
          {currentSpaceState.value.name || "Unnamed"}
        </span>
      </div>
    {/if}

    {#if navbar.content}
      {@render navbar.content()}
    {/if}
  </Navbar>

  <div class="flex flex-col h-full max-h-full overflow-y-hidden">
    <SyncStatusBanner />
    {@render children()}
  </div>
</div>

<!-- Mobile backdrop -->
{#if mobileSidebar.visible}
  <button
    onclick={() => (mobileSidebar.visible = false)}
    aria-label="toggle navigation"
    class="fixed inset-0 z-30 cursor-pointer sm:hidden bg-base-100/50 dark:bg-base-950/50"
  ></button>
{/if}

<!-- Fixed sidebar (full height, left) -->
<div
  class={[
    "isolate fixed top-0 bottom-0 left-0 z-40 bg-base-100/50 dark:bg-base-950 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none",
    mobileSidebar.visible ? "block" : "hidden sm:block",
  ]}
>
  <div class="flex h-full w-fit">
    <BigSidebar>
      <RoomyHomeCard
        onClick={() => goto("/")}
        small={compact}
      />
      {#if sidebar}
        {@render sidebar()}
      {/if}
      {#snippet footer()}
        <SidebarUserCard />
      {/snippet}
    </BigSidebar>
  </div>
</div>