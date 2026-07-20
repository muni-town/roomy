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
  import EnableNotificationsBanner from "./EnableNotificationsBanner.svelte";
  import ServerBar from "$lib/components/sidebar/ServerBar.svelte";

let {
    children,
  }: {
    children: Snippet;
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
    "h-full flex flex-col overflow-hidden main-panel bg-white dark:bg-base-950",
    "sm:ml-64",
  ]}
>
  <EnableNotificationsBanner />
  <Navbar {compact} class={compact ? "h-11 dark:bg-base-900/20" : "dark:bg-base-900/20"}>
    <div class="flex items-center min-w-0">
      <div class="flex gap-2 items-center ml-2 sm:hidden">
        <ToggleNavigation bind:isSidebarVisible={mobileSidebar.visible} />
      </div>

      {#if compact}
        {#if navbar.spaceInfo}
          {@render navbar.spaceInfo?.()}
        {:else}
          <NavbarSpaceInfo />
        {/if}
      {/if}
    </div>

    {#if navbar.content}
      {@render navbar.content?.()}
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
    "isolate fixed top-0 bottom-0 left-0 z-40 overflow-hidden bg-base-50/50 dark:bg-base-950 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none sidebar-fixed",
    mobileSidebar.visible ? "block" : "hidden sm:block",
  ]}
>
  <div class="flex flex-col h-full">
    <!-- Space header: sits above the sidebar row, spanning the BigSidebar
         width (256px). The space selector overlays the row below. -->
    <div
      class="shrink-0 sidebar-header-wrapper"
      class:on-homepage={onHomepage}
    >
      {#if sidebarHeader.content}
        {@render sidebarHeader.content?.()}
      {/if}
    </div>
    <div class="relative flex flex-1 min-h-0 w-64 overflow-hidden sidebar-row">
      <!-- BigSidebar: slides in from the right on space pages, out to the
           right on the homepage OR when the space selector is opened on a
           space page. Driving both states from the same condition keeps the
           main sidebar and the space selector on one pannable plane: opening
           the selector pushes the main sidebar out to the right (mirroring
           the directory → space transition) instead of overlaying it.
           Absolute positioning keeps the row at a constant 256px (no layout
           jump / overlap), and the row's overflow-hidden clips the slide.
           Animating transform only — no max-width curtain — avoids the
           content being clipped mid-slide, which previously caused the
           sidebar to flash in partway through. -->
      <div
        class="absolute inset-y-0 left-0 w-64 h-full flex flex-col big-sidebar-wrapper"
        class:big-sidebar-hidden={onHomepage || serverBar.expanded}
        class:big-sidebar-visible={!onHomepage && !serverBar.expanded}
      >
        <BigSidebar>
          {#if sidebar}
            {@render sidebar?.()}
          {/if}
        </BigSidebar>
      </div>
      <!-- Space selector (wide server bar): a SINGLE element, shown on the
           homepage (always) and on space pages when toggled. Because it is
           one element, navigating between states where it stays visible —
           e.g. the selector open on a space, then going to the homepage —
           does not unmount/remount it, so it stays put instead of
           disappearing and sliding back in. It only animates when its
           visibility actually changes. When it opens on a space page the
           BigSidebar pans out to the right in lockstep (see
           big-sidebar-wrapper above), so the two read as one pannable plane;
           z-20 only matters at rest to keep the selector above the
           BigSidebar's residual space. -->
      <div
        class="space-selector-overlay bg-base-50 dark:bg-base-950"
        class:open={onHomepage || serverBar.expanded}
      >
        <ServerBar wide={true} />
      </div>
    </div>
    <!-- User card sits below the sidebar row, spanning the sidebar width. -->
    <div
      class="shrink-0 sidebar-user-card-wrapper"
      class:on-homepage={onHomepage}
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

  /* ── BigSidebar wrapper: pure translateX slide on the compositor.
     The row clips at 256px so the slide never overflows the main panel.
     No max-width animation: animating both max-width and translateX with
     overflow:hidden previously clipped the content partway through the
     slide, making the sidebar flash in mid-transition. ── */
  .big-sidebar-wrapper {
    contain: layout style paint;
    transition: transform 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: transform;
  }
  .big-sidebar-wrapper.big-sidebar-visible {
    transform: translateX(0);
  }
  .big-sidebar-wrapper.big-sidebar-hidden {
    transform: translateX(100%);
  }

  .sidebar-fixed {
    contain: layout style;
    padding-top: env(safe-area-inset-top);
    padding-left: env(safe-area-inset-left);
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
    width: 256px;
    contain: layout style;
  }
  .sidebar-user-card-wrapper.on-homepage {
    border-right: none;
  }

  /* ── Space header wrapper: constant 256px bar above the sidebar row.
     The space selector overlays the row below instead of pushing the
     sidebar wider, so this no longer animates. ── */
  .sidebar-header-wrapper {
    z-index: 50;
    width: 256px;
    /* Reserve the space header height (32px avatar + 24px toggle py-3 + 1px
       bottom border = 57px) even when empty (homepage), so the sidebar row
       below doesn't shift vertically between the homepage and space pages. */
    min-height: 57px;
    contain: layout style;
  }
  .sidebar-header-wrapper.on-homepage {
    border-right: none;
    /* Match the sidebar row below (the ServerBar / space-selector overlay
       uses bg-base-50 dark:bg-base-950) so the header doesn't read as a
       lighter strip in light mode. */
    background-color: var(--color-base-50);
  }
  :global(.dark) .sidebar-header-wrapper.on-homepage {
    background-color: var(--color-base-950);
  }

  /* ── Space selector (wide server bar): shown on the homepage (always)
     and on space pages when toggled. Slides in from the left on the
     compositor thread. A single shared element for both contexts so it
     doesn't unmount/remount across a navigation that leaves it visible. ── */
  .space-selector-overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 256px;
    z-index: 20;
    transform: translateX(-100%);
    opacity: 0;
    pointer-events: none;
    transition:
      transform 400ms cubic-bezier(0.33, 1, 0.68, 1),
      opacity 300ms ease;
    will-change: transform;
    contain: layout style;
  }
  .space-selector-overlay.open {
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }
  /* The selector sits on top of the BigSidebar, which has no right border;
     drop the wide server bar's right border so opening the selector doesn't
     draw a separator line that isn't there when it's closed. */
  .space-selector-overlay :global(.sidebar-server-bar) {
    border-right: none;
  }
</style>