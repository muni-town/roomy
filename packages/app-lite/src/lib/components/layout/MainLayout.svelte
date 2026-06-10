<script lang="ts" module>
  export const isSidebarVisible = $state({ value: false });
</script>

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
    isSidebarVisible.value = false;
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
      <ToggleNavigation bind:isSidebarVisible={isSidebarVisible.value} />
    </div>

    {#if navbar.content}
      {@render navbar.content()}
    {/if}

    <div class="ml-auto hidden sm:block">
      <SidebarUserCard side="bottom" />
    </div>

    <div class="ml-auto sm:hidden">
      <SidebarUserCard side="bottom" />
    </div>
  </Navbar>

  <div class="flex flex-col h-full max-h-full overflow-y-hidden">
    <SyncStatusBanner />
    {@render children()}
  </div>
</div>

<!-- Mobile overlay -->
{#if isSidebarVisible.value}
  <button
    onclick={() => (isSidebarVisible.value = false)}
    aria-label="toggle navigation"
    class="fixed inset-0 z-30 cursor-pointer sm:hidden bg-base-100/50 dark:bg-base-950/50"
  ></button>
{/if}

<!-- Fixed sidebars -->
<div
  class={[
    "isolate fixed top-0 bottom-0 left-0 z-40 bg-base-100/50 dark:bg-base-950 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none",
    isSidebarVisible.value ? "block" : "hidden sm:block",
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
    </BigSidebar>
  </div>
</div>
