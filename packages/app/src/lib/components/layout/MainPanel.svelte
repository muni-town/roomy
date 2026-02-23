<script lang="ts">
  import { type Snippet } from "svelte";
  import ToggleNavigation from "../helper/ToggleNavigation.svelte";
  import Navbar from "./Navbar.svelte";
  import { isSidebarVisible } from "./MainLayout.svelte";
  import { cn } from "@foxui/core";
  import * as rawEnv from "$env/static/public";

  let {
    sidebar,
    navbar,
    children,
    chatArea = false,
  }: {
    sidebar?: Snippet;
    navbar?: Snippet;
    children: Snippet;
    chatArea?: boolean;
  } = $props();

  // @ts-ignore
  const hideSmallSidebar = rawEnv.PUBLIC_HIDE_SMALL_SIDEBAR;
</script>

<div
  class={cn(
    "h-dvh flex flex-col overflow-hidden",
    hideSmallSidebar
      ? sidebar
        ? "sm:ml-64"
        : "sm:ml-0"
      : sidebar
        ? "sm:ml-82"
        : "sm:ml-18",
    chatArea ? "bg-white dark:bg-base-950" : "",
  )}
>
  {#if navbar}
    <Navbar>
      {#if !hideSmallSidebar || sidebar}
        <div class="flex gap-4 items-center ml-4 sm:hidden">
          <ToggleNavigation bind:isSidebarVisible={isSidebarVisible.value} />
        </div>
      {/if}

      {@render navbar?.()}
    </Navbar>
  {/if}

  <div class="flex flex-col h-full max-h-full overflow-y-hidden">
    {@render children?.()}
  </div>
</div>
