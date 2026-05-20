<script lang="ts" module>
  export const isSidebarVisible = $state({ value: false });
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { onNavigate } from "$app/navigation";
  import SmallSidebar from "@roomy/design/components/layout/SmallSidebar.svelte";
  import BigSidebar from "@roomy/design/components/layout/BigSidebar.svelte";
  import Navbar from "@roomy/design/components/layout/Navbar.svelte";
  import ToggleNavigation from "@roomy/design/components/helper/ToggleNavigation.svelte";
  import { navbar } from "./navbar.svelte";

  let {
    serverBar,
    sidebar,
    children,
    chatArea = false,
  }: {
    serverBar?: Snippet;
    sidebar?: Snippet;
    children: Snippet;
    chatArea?: boolean;
  } = $props();

  onNavigate(() => {
    isSidebarVisible.value = false;
  });
</script>

<!-- Main panel: navbar + page content, offset to clear the fixed sidebars -->
<div
  class={[
    "h-full flex flex-col overflow-hidden",
    sidebar ? "sm:ml-82" : "sm:ml-18",
    chatArea ? "bg-white dark:bg-base-950" : "",
  ]}
>
  <Navbar>
    <div class="flex gap-4 items-center ml-2 sm:hidden">
      <ToggleNavigation bind:isSidebarVisible={isSidebarVisible.value} />
    </div>

    {#if navbar.content}
      {@render navbar.content()}
    {/if}
  </Navbar>

  <div class="flex flex-col h-full max-h-full overflow-y-hidden">
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
    {#if serverBar}
      <SmallSidebar>
        {@render serverBar()}
      </SmallSidebar>
    {/if}
    {#if sidebar}
      <BigSidebar>
        {@render sidebar()}
      </BigSidebar>
    {/if}
  </div>
</div>
