<script lang="ts">
  import type { Snippet } from "svelte";
  import { onNavigate } from "$app/navigation";
  import { browser } from "$app/environment";
  import BigSidebar from "@roomy/design/components/layout/BigSidebar.svelte";
  import Navbar from "@roomy/design/components/layout/Navbar.svelte";
  import SidebarUserCard from "$lib/components/sidebar/SidebarUserCard.svelte";
  import ToggleNavigation from "@roomy/design/components/helper/ToggleNavigation.svelte";
  import { navbar } from "./navbar.svelte";
  import { sidebarOverride, sidebarContent } from "./sidebar.svelte";
  import { mobileSidebar } from "./mobile-sidebar.svelte";
  import { serverBar } from "./server-bar.svelte";
  import { wideSidebar } from "./wide-sidebar.svelte";
  import NavbarSpaceInfo from "./NavbarSpaceInfo.svelte";
  import SyncStatusBanner from "./SyncStatusBanner.svelte";
  import ServerBar from "$lib/components/sidebar/ServerBar.svelte";
  import { animate } from "$lib/animations";

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

  const sidebarWidth = $derived(
    onHomepage
      ? "sm:ml-64"
      : serverBar.expanded
        ? "sm:ml-[20rem]"
        : "sm:ml-64",
  );

  const sidebar = $derived(sidebarOverride.content ?? sidebarContent.content);

  // Animate the main panel margin when sidebar layout changes
  // Only applies at sm: breakpoint and above — mobile uses slide-over sidebar
  let mainPanel = $state<HTMLElement | null>(null);
  let isWideScreen = $state(false);
  let bigSidebarWrapper = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!browser) return;
    const mq = window.matchMedia("(min-width: 640px)");
    isWideScreen = mq.matches;
    const handler = () => (isWideScreen = mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  $effect(() => {
    if (!mainPanel || !isWideScreen) return;
    let targetWidth: number;
    if (onHomepage) {
      targetWidth = 256;
    } else {
      targetWidth = serverBar.expanded ? 320 : 256;
    }
    animate(mainPanel, {
      marginLeft: targetWidth,
      duration: 400,
      ease: "easeOutCubic",
    });
  });

  // Animate BigSidebar wrapper width: shrinks to 0 on homepage, expands to 256 on space page
  // Also fade the BigSidebar content to transparent as it shrinks
  $effect(() => {
    if (!bigSidebarWrapper) return;
    const bigSidebar = bigSidebarWrapper.firstElementChild as HTMLElement | null;
    if (!bigSidebar) return;

    if (onHomepage) {
      animate(bigSidebarWrapper, {
        width: 0,
        duration: 400,
        ease: "easeOutCubic",
      });
      animate(bigSidebar, {
        opacity: 0,
        duration: 400,
        ease: "easeOutCubic",
      });
    } else {
      animate(bigSidebarWrapper, {
        width: 256,
        duration: 400,
        ease: "easeOutCubic",
      });
      animate(bigSidebar, {
        opacity: 1,
        duration: 400,
        ease: "easeOutCubic",
      });
    }
  });

  onNavigate(() => {
    mobileSidebar.visible = false;
  });
</script>

<!-- Main panel: navbar + page content, offset to clear the fixed sidebar -->
<div
  bind:this={mainPanel}
  class={[
    "h-full flex flex-col overflow-hidden",
    onHomepage ? "sm:ml-64" : serverBar.expanded ? "sm:ml-[20rem]" : "sm:ml-64",
    chatArea ? "bg-white dark:bg-base-950" : "",
  ]}
>
  <Navbar {compact} class={compact ? "h-11" : undefined}>
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
    "isolate fixed top-0 bottom-0 left-0 z-40 overflow-hidden bg-base-100/50 dark:bg-base-950 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none",
    mobileSidebar.visible ? "block" : "hidden sm:block",
  ]}
>
  <div class="relative flex h-full">
      <!-- Server bar + BigSidebar: on homepage the server bar expands to w-64
      and the BigSidebar slides right out of view -->
      <ServerBar wide={onHomepage} expanded={serverBar.expanded} />
      <div bind:this={bigSidebarWrapper} class="overflow-hidden w-64 shrink-0 h-full flex flex-col">
        <BigSidebar>
          {#if sidebar}
            {@render sidebar()}
          {/if}
        </BigSidebar>
      </div>
    <!-- Full-width user card overlay spanning both server bar and main sidebar -->
    <div class="absolute bottom-0 left-0 w-full z-50">
      <SidebarUserCard />
    </div>
  </div>
</div>