<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    loading = false,
    header,
    actions,
    saveAction,
    prefix,
    loneRoom,
    body,
    footer,
    bodySlideOut = false,
    overlayBody,
    overlayOpen = false,
  }: {
    /** When true, render a skeleton in place of the body. */
    loading?: boolean;
    /** Top-of-sidebar content (typically the SpaceHeaderShell). Optional — when omitted, the header is rendered externally (e.g. by MainLayout as a full-width bar). */
    header?: Snippet;
    /** Optional toolbar/actions row rendered right below the header (e.g. space switcher, home, settings). */
    actions?: Snippet;
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
    /** When true, slide the body out to the left (e.g. to reveal a settings overlay). */
    bodySlideOut?: boolean;
    /** Optional overlay panel rendered above the body, sliding in from the right (e.g. settings). */
    overlayBody?: Snippet;
    /** When true, the overlay panel is slid into view. */
    overlayOpen?: boolean;
  } = $props();
</script>

<div class="flex flex-col flex-1 min-h-0 h-full">
{#if header}
<div class="shrink-0 w-64">
{@render header?.()}
</div>
{/if}

{#if actions}
  <div class="shrink-0">
    {@render actions?.()}
  </div>
{/if}

{#if loading}
  <div class="px-4">
    <div class="h-4 bg-base-200 rounded animate-pulse w-3/4 mb-2"></div>
    <div class="h-3 bg-base-200 rounded animate-pulse w-1/2"></div>
  </div>
{:else}
  {#if saveAction}{@render saveAction?.()}{/if}

  <div class="relative flex-1 min-h-0 flex flex-col overflow-hidden sidebar-body-wrap">
    <div
      class="w-full h-full px-2 pt-3 pb-20 mask-[linear-gradient(to_bottom,transparent_0%,black_2%,black_95%,transparent_100%)] flex-1 min-h-0 overflow-y-scroll sidebar-body-slide"
      class:sidebar-body-slide-out={bodySlideOut}
    >
      {#if prefix}{@render prefix?.()}{/if}
      {#if loneRoom}{@render loneRoom?.()}{/if}
      {#if body}{@render body?.()}{/if}
    </div>
    {#if overlayBody}
      <div
        class="absolute inset-0 sidebar-overlay-slide"
        class:sidebar-overlay-slide-open={overlayOpen}
      >
        {@render overlayBody?.()}
      </div>
    {/if}
  </div>

  {#if footer}{@render footer?.()}{/if}
{/if}
</div>

<style>
  /* ── Body slide: translate the channels body out to the left so a panel
     (e.g. settings) can slide in from the right, mirroring the directory /
     space-selector pattern but in the opposite direction. The body-wrap
     clips (overflow-hidden) so the slide never overflows the sidebar. ── */
  .sidebar-body-slide {
    transition: transform 400ms cubic-bezier(0.33, 1, 0.68, 1);
    will-change: transform;
  }
  .sidebar-body-slide-out {
    transform: translateX(-100%);
  }

  /* ── Overlay panel: slides in from the right on the compositor thread.
     Default (closed) sits off-screen to the right, transparent and
     non-interactive so it never blocks the body underneath. ── */
  .sidebar-overlay-slide {
    transform: translateX(100%);
    opacity: 0;
    pointer-events: none;
    transition:
      transform 400ms cubic-bezier(0.33, 1, 0.68, 1),
      opacity 300ms ease;
    will-change: transform;
  }
  .sidebar-overlay-slide-open {
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }
</style>