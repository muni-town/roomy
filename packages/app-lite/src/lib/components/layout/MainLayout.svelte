<script lang="ts">
  import type { Snippet } from "svelte";
  import { onNavigate } from "$app/navigation";
  import BigSidebar from "@roomy/design/components/layout/BigSidebar.svelte";
  import Navbar from "@roomy/design/components/layout/Navbar.svelte";
  import SidebarUserCard from "$lib/components/sidebar/SidebarUserCard.svelte";
  import ToggleNavigation from "@roomy/design/components/helper/ToggleNavigation.svelte";
  import { navbar } from "./navbar.svelte";
  import { sidebarOverride, sidebarContent, sidebarHeader } from "./sidebar.svelte";
  import { mobileSidebar } from "./mobile-sidebar.svelte";
  import { serverBar } from "./server-bar.svelte";
  import { wideSidebar } from "./wide-sidebar.svelte";
  import NavbarSpaceInfo from "./NavbarSpaceInfo.svelte";
  import SyncStatusBanner from "./SyncStatusBanner.svelte";
  import ServerBar from "$lib/components/sidebar/ServerBar.svelte";

let {
    children,
    chatArea = false,
  }: {
    children: Snippet;
    chatArea?: boolean;
  } = $props();

  // Compact mode when on a space page or other inner route (not a wide-sidebar page)
  const compact = $derived(!wideSidebar.active);

  // Wide sidebar mode: homepage-style layout (wide server bar, no BigSidebar)
  const onHomepage = $derived(wideSidebar.active);

  const sidebar = $derived(sidebarOverride.content ?? sidebarContent.content);

  onNavigate(() => {
    mobileSidebar.visible = false;
  });
</script>

<!-- Main panel: navbar + page content, offset to clear the fixed sidebar -->
<div
  class={[
    "h-full flex flex-col overflow-hidden main-panel",
    chatArea ? "bg-white dark:bg-base-950" : "",
    onHomepage
      ? "sm:ml-64"
      : serverBar.expanded
        ? "sm:ml-[20rem]"
        : "sm:ml-64",
  ]}
>
  <Navbar {compact} class={compact ? "h-11 dark:bg-base-900/20" : "dark:bg-base-900/20"}>
    <div class="flex gap-4 items-center mr-auto ml-2 sm:hidden">
      <ToggleNavigation bind:isSidebarVisible={mobileSidebar.visible} />
    </div>

    {#if compact}
      <NavbarSpaceInfo />
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

<!-- Mobile backdrop: always in DOM, opacity transition avoids layout thrash from #if -->
<button
  onclick={() => (mobileSidebar.visible = false)}
  aria-label="toggle navigation"
  class="fixed inset-0 z-30 sm:hidden cursor-pointer mobile-backdrop"
  class:mobile-backdrop-visible={mobileSidebar.visible}
  class:mobile-backdrop-hidden={!mobileSidebar.visible}
></button>

<!-- Fixed sidebar (full height, left) -->
<div
  class={[
    "isolate fixed top-0 bottom-0 left-0 z-40 overflow-hidden bg-base-100/50 dark:bg-base-950 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none sidebar-fixed",
    mobileSidebar.visible ? "block" : "hidden sm:block",
  ]}
>
  <div class="flex flex-col h-full">
    <!-- Space header: sits above the server bar / BigSidebar row and spans the
         full sidebar width (server bar + BigSidebar), mirroring the user card.
         The space selector (server bar) pops out underneath it. -->
    <div
      class="shrink-0 sidebar-header-wrapper"
      class:on-homepage={onHomepage}
      class:not-homepage={!onHomepage}
      class:server-collapsed={!serverBar.expanded}
    >
      {#if sidebarHeader.content}
        {@render sidebarHeader.content()}
      {/if}
    </div>
    <div class="relative flex flex-1 min-h-0">
      <!-- Server bar + BigSidebar: on homepage the server bar expands to w-64
      and the BigSidebar slides right out of view -->
      <ServerBar wide={onHomepage} expanded={serverBar.expanded} />
      <!-- BigSidebar wrapper: slides left via translateX + overflow:hidden
           instead of animating width, keeping animation on the compositor -->
      <div
        class="overflow-hidden shrink-0 w-64 h-full flex flex-col big-sidebar-wrapper"
        class:big-sidebar-hidden={onHomepage}
        class:big-sidebar-visible={!onHomepage}
      >
        <div
          class="big-sidebar-content big-sidebar-content-spacer"
          class:big-sidebar-content-hidden={onHomepage}
          class:big-sidebar-content-visible={!onHomepage}
        >
          <BigSidebar>
            {#if sidebar}
              {@render sidebar()}
            {/if}
          </BigSidebar>
        </div>
      </div>
    </div>
    <!-- User card sits below the sidebar row, constrained to the visible width. -->
    <!-- On the homepage it only covers the server bar (w-64).
         On space pages it covers server bar + BigSidebar. -->
    <div
      class="shrink-0 sidebar-user-card-wrapper"
      class:on-homepage={onHomepage}
      class:not-homepage={!onHomepage}
      class:server-collapsed={!serverBar.expanded}
    >
      <SidebarUserCard />
    </div>
  </div>
</div>

<style>
  /* ── Main panel margin transition ────────────────────────────── */
  .main-panel {
    transition: margin-left 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: margin-left;
  }

  /* ── BigSidebar wrapper: translateX on compositor thread ────── */
  .big-sidebar-wrapper {
    contain: layout style paint;
    transition:
      max-width 400ms cubic-bezier(0.33, 1, 0.68, 1),
      transform 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: transform, max-width;
  }
  .big-sidebar-wrapper.big-sidebar-visible {
    transform: translateX(0);
    max-width: 256px;
  }
  .big-sidebar-wrapper.big-sidebar-hidden {
    /* Slide 256px to the right (out of view behind the overflowing server bar area),
       plus an extra 20px for a nice parallax feel */
    transform: translateX(276px);
    max-width: 0;
  }

  /* ── BigSidebar content fade ────────────────────────────────── */
  .big-sidebar-content {
    transition: opacity 350ms ease;
    will-change: opacity;
  }
  .big-sidebar-content.big-sidebar-content-visible {
    opacity: 1;
  }
  .big-sidebar-content.big-sidebar-content-hidden {
    opacity: 0;
  }

  /* ── Sidebar fixed container: compositor isolation ──────────── */
  .sidebar-fixed {
    contain: layout style;
  }

  /* ── Mobile backdrop: opacity animation to avoid DOM insert/remove ── */
  .mobile-backdrop {
    opacity: 0;
    pointer-events: none;
    transition: opacity 250ms ease;
    background-color: color-mix(in srgb, var(--color-base-100) 50%, transparent);
  }
  :global(.dark) .mobile-backdrop {
    background-color: color-mix(in srgb, var(--color-base-950) 50%, transparent);
  }
  .mobile-backdrop.mobile-backdrop-visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* ── User card width: matches the visible sidebar width ────────── */
  .sidebar-user-card-wrapper {
    z-index: 50;
    transition:
      width 400ms cubic-bezier(0.33, 1, 0.68, 1),
      border-right-width 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: width;
    contain: layout style;
  }
  /* Homepage: wide server bar only (w-64 = 256px), BigSidebar hidden */
  .sidebar-user-card-wrapper.on-homepage {
    width: 256px;
    border-right: none;
  }
  /* Space page, server bar expanded: server bar (64px) + BigSidebar (256px) = 320px */
  .sidebar-user-card-wrapper.not-homepage:not(.server-collapsed) {
    width: 320px;
  }
  /* Space page, server bar collapsed: just BigSidebar (256px) */
  .sidebar-user-card-wrapper.not-homepage.server-collapsed {
    width: 256px;
  }

  /* ── BigSidebar spacer to prevent content hiding behind user card ── */
  .big-sidebar-content-spacer {
    padding-bottom: 80px;
  }

  /* ── Space header wrapper: full-width bar above the server bar / BigSidebar,
     mirroring the user card width behaviour so the space selector pops out
     underneath the header. ── */
  .sidebar-header-wrapper {
    z-index: 50;
    transition:
      width 400ms cubic-bezier(0.33, 1, 0.68, 1),
      border-right-width 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: width;
    contain: layout style;
  }
  /* Homepage: wide server bar only (w-64 = 256px), BigSidebar hidden */
  .sidebar-header-wrapper.on-homepage {
    width: 256px;
    border-right: none;
  }
  /* Space page, server bar expanded: server bar (64px) + BigSidebar (256px) = 320px */
  .sidebar-header-wrapper.not-homepage:not(.server-collapsed) {
    width: 320px;
  }
  /* Space page, server bar collapsed: just BigSidebar (256px) */
  .sidebar-header-wrapper.not-homepage.server-collapsed {
    width: 256px;
  }
</style>