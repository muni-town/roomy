<script lang="ts" module>
  export const isSidebarVisible = $state({ value: false });
</script>

<script lang="ts">
  import { type Snippet } from "svelte";
  import { onNavigate } from "$app/navigation";

  import SmallSidebar from "./SmallSidebar.svelte";
  import ServerBar from "../sidebars/ThinSidebar.svelte";
  import BigSidebar from "./BigSidebar.svelte";
  import MainPanel from "./MainPanel.svelte";
  import * as rawEnv from "$env/static/public";

  let {
    serverBar,
    sidebar,
    navbar,
    children,
    chatArea = false,
  }: {
    serverBar?: Snippet;
    sidebar?: Snippet;
    navbar?: Snippet;
    children: Snippet;
    chatArea?: boolean;
  } = $props();

  onNavigate(() => {
    isSidebarVisible.value = false;
  });

  // @ts-ignore
  const hideSmallSidebar = rawEnv.PUBLIC_HIDE_SMALL_SIDEBAR;
</script>

<MainPanel {children} {navbar} {sidebar} {chatArea} />

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
      <BigSidebar>
        {@render sidebar?.()}
      </BigSidebar>
    {/if}
  </div>
</div>
