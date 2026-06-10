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

<!-- Full-width wrapper fills the body -->
<div class="h-full flex flex-col">
  <!-- Full-width navbar at the top -->
  <Navbar {compact}>
    <div class="flex items-center gap-1 sm:gap-2">
      <RoomyHomeCard
        onClick={() => goto("/")}
        onMobileClick={() => {
          if (isSidebarVisible.value) {
            goto("/");
            isSidebarVisible.value = false;
          } else {
            isSidebarVisible.value = true;
          }
        }}
        small={compact}
      />
    </div>

    {#if navbar.content}
      {@render navbar.content()}
    {/if}

    <SidebarUserCard side="bottom" />
  </Navbar>

  <!-- Main area: sidebar + content in a row -->
  <div class="flex flex-1 overflow-hidden relative">
    <!-- Desktop sidebar (normal flow) -->
    <div class="hidden sm:block w-64 shrink-0">
      <BigSidebar>
        {#if sidebar}
          {@render sidebar()}
        {/if}
      </BigSidebar>
    </div>

    <!-- Mobile backdrop (below navbar, overlays content only) -->
    {#if isSidebarVisible.value}
      <button
        onclick={() => (isSidebarVisible.value = false)}
        aria-label="toggle navigation"
        class="absolute inset-0 z-30 cursor-pointer sm:hidden bg-base-100/50 dark:bg-base-950/50"
      ></button>
    {/if}

    <!-- Mobile sidebar (below navbar, overlays content) -->
    {#if isSidebarVisible.value}
      <div class="absolute inset-y-0 left-0 z-40 sm:hidden bg-base-100/50 dark:bg-base-950 backdrop-blur-sm">
        <div class="flex h-full w-fit">
          <BigSidebar>
            {#if sidebar}
              {@render sidebar()}
            {/if}
          </BigSidebar>
        </div>
      </div>
    {/if}

    <!-- Content area -->
    <div
      class={[
        "flex flex-col flex-1 overflow-hidden",
        chatArea ? "bg-white dark:bg-base-950" : "",
      ]}
    >
      <SyncStatusBanner />
      {@render children()}
    </div>
  </div>
</div>
