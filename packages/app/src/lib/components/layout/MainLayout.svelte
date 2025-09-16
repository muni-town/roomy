<script lang="ts" module>
  export const isSidebarVisible = $state({ value: false });
</script>

<script lang="ts">
  import Navbar from "./Navbar.svelte";
  // import BigSidebar from "./BigSidebar.svelte";
  // import SmallSidebar from "./SmallSidebar.svelte";
  import { type Snippet } from "svelte";
  import ToggleNavigation from "../helper/ToggleNavigation.svelte";
  import { cn, Tooltip } from "@fuxui/base";
  // import ServerBar from "../sidebars/ServerBar.svelte";
  import { onNavigate } from "$app/navigation";
  import * as rawEnv from "$env/static/public";
  import SmallSidebar from "./SmallSidebar.svelte";
  import ServerBar from "../sidebars/ServerBar.svelte";
  import { backendStatus } from "$lib/workers";
  import Icon from "@iconify/svelte";

  let {
    serverBar,
    sidebar,
    navbar,
    children,
  }: {
    serverBar?: Snippet;
    sidebar?: Snippet;
    navbar?: Snippet;
    children: Snippet;
  } = $props();

  onNavigate(() => {
    isSidebarVisible.value = false;
  });

  // @ts-ignore
  const hideSmallSidebar = rawEnv.PUBLIC_HIDE_SMALL_SIDEBAR;
</script>

<div
  class={cn(
    "h-[100dvh] flex flex-col overflow-hidden",
    hideSmallSidebar
      ? sidebar
        ? "sm:ml-64"
        : "sm:ml-0"
      : sidebar
        ? "sm:ml-82"
        : "sm:ml-18",
  )}
>
  <Navbar>
    {#if !hideSmallSidebar || sidebar}
      <div class="flex gap-4 items-center ml-4 sm:hidden">
        <ToggleNavigation bind:isSidebarVisible={isSidebarVisible.value} />
      </div>
    {/if}

    {@render navbar?.()}
  </Navbar>

  {@render children?.()}
</div>

<!-- Overlay -->
{#if isSidebarVisible.value}
  <button
    onclick={() => {
      isSidebarVisible.value = !isSidebarVisible.value;
    }}
    aria-label="toggle navigation"
    class="absolute inset-0 cursor-pointer sm:hidden bg-base-100/50 dark:bg-base-950/50"
  ></button>
{/if}

<div
  class={[
    "isolate fixed top-0 bottom-0 left-0 bg-base-100/50 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none",
    isSidebarVisible.value ? "block" : "hidden sm:block",
  ]}
>
  <div class="flex h-full w-fit">
    {#if !hideSmallSidebar}
      <SmallSidebar>
        {#if serverBar}
          {@render serverBar?.()}
        {:else}
          <ServerBar />
        {/if}
      </SmallSidebar>
    {/if}
    {#if sidebar}
      <!-- <BigSidebar>
        {@render sidebar?.()}
      </BigSidebar> -->
    {/if}
  </div>
</div>
