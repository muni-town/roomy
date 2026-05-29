<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    loading = false,
    header,
    saveAction,
    prefix,
    loneRoom,
    body,
    footer,
  }: {
    /** When true, render a skeleton in place of the body. */
    loading?: boolean;
    /** Top-of-sidebar content (typically the SpaceHeaderShell). Always rendered. */
    header: Snippet;
    /** Optional "Finish editing" save button rendered above the prefix when editing. */
    saveAction?: Snippet;
    /** Top buttons row (Home, Index, Events, separator). */
    prefix?: Snippet;
    /** Optional badge for the currently active room when it's not in the sidebar. */
    loneRoom?: Snippet;
    /** Category list area. */
    body?: Snippet;
    /** Bottom-of-sidebar content (typically Archive button when editing). */
    footer?: Snippet;
  } = $props();
</script>

{@render header()}

{#if loading}
  <div class="px-4 mt-2">
    <div class="h-4 bg-base-200 rounded animate-pulse w-3/4 mb-2"></div>
    <div class="h-3 bg-base-200 rounded animate-pulse w-1/2"></div>
  </div>
{:else}
  {#if saveAction}{@render saveAction()}{/if}

  <div class="w-full pt-2 px-2">
    {#if prefix}{@render prefix()}{/if}
    {#if loneRoom}{@render loneRoom()}{/if}
    {#if body}{@render body()}{/if}
  </div>

  {#if footer}{@render footer()}{/if}
{/if}
