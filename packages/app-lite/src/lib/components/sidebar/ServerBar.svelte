<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconMasonryGrid } from "@roomy/design/icons";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import { createSpacesQuery } from "$lib/queries/spaces";

  let {
    wide = false,
    expanded = true,
  }: {
    /** When true, render at full sidebar width with space names next to avatars */
    wide?: boolean;
    /** When true, show at full width (w-64). When false, collapse to w-16. */
    expanded?: boolean;
  } = $props();

  // We use CSS transitions on transform + opacity instead of animating `width`
  // (which triggers layout). The wrapper clips with overflow-hidden so a
  // translateX animation stays entirely on the compositor thread.
  let el = $state<HTMLElement | null>(null);

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  const joinedSpaces = $derived(
    (spacesQuery.data?.spaces ?? []).filter((s) => s.isMember),
  );

  const currentSpaceId = $derived(page.params.space);

  function navigateToSpace(spaceId: string) {
    goto(`/${spaceId}`);
  }

  // CSS-based animation: translateX stays on the compositor thread.
  // The parent container clips with overflow-hidden so translating beyond
  // its bounds is visually identical to resizing width.
  const animClass = $derived(
    wide
      ? "server-bar-wide"
      : expanded
        ? "server-bar-expanded"
        : "server-bar-collapsed",
  );
</script>

<div
  bind:this={el}
  class={[
    "flex flex-col py-1 bg-base-100/50 dark:bg-base-950 min-h-0 gap-2 overflow-hidden relative z-10 sidebar-server-bar",
    wide
      ? "w-64 border-r border-base-950/5 dark:border-base-300/10"
      : "w-16 items-center",
    animClass,
  ].join(" ")}
>
  <!-- Home button -->
  <div class={wide ? "mx-2" : "flex justify-center"}>
    <Button
      href="/"
      variant="ghost"
      class={[
        "size-12 p-0 rounded-xl [&_svg]:size-6",
        wide ? "flex items-center gap-5 px-3 w-full justify-start" : "",
      ].join(" ")}
      aria-label="Home"
      title="Home"
    >
      <IconMasonryGrid />
      {#if wide}
        <span class="text-md font-semibold truncate text-base-700 dark:text-base-300 hover:text-black dark:hover:text-white">Home</span>
      {/if}
    </Button>
  </div>

  <!-- Divider -->
  <div
    class={[
      "h-px bg-base-300/50 dark:bg-base-700/50",
      wide ? "mx-4" : "w-8 mx-auto",
    ].join(" ")}
  ></div>

  <!-- Space list -->
  <div
    class={[
      "flex flex-col overflow-y-auto flex-1 gap-1 w-full",
      wide ? "" : "items-center",
    ].join(" ")}
  >
    {#each joinedSpaces as space (space.id)}
      <button
        onclick={() => navigateToSpace(space.id)}
        class={[
          "transition-[opacity,background-color] cursor-pointer opacity-90 hover:opacity-100 my-0.5",
          wide
            ? "flex items-center gap-3 h-12 pl-2 pr-1.5 rounded-lg text-left hover:bg-base-300/30 dark:hover:bg-base-800/30"
            : "relative flex items-center justify-center size-12",
          space.id === currentSpaceId ? "active" : "",
        ].join(" ")}
        title={space.name ?? "Unnamed Space"}
      >
        <div class="relative shrink-0">
        <SpaceAvatar
          src={resolveBlobUrl(space.avatar)}
          id={space.id}
          name={space.name ?? undefined}
          size={48}
          shape="squircle"
          ringVar="--avatar-ring"
        />
        {#if space.unreadCount > 0}
          <div
            class="absolute bottom-0.5 left-0.5 size-1.5 rounded-full bg-accent-500 ring-1 ring-base-100 dark:ring-base-950"
          ></div>
        {/if}
        </div>
        {#if wide}
          <div class="flex flex-col min-w-0">
            <span
              class="text-md font-semibold truncate text-base-700 dark:text-base-300 hover:text-black dark:hover:text-white"
            >
              {space.name ?? "Unnamed Space"}
            </span>
            {#if space.unreadCount > 0}
              <span
                class="text-xs text-base-500 dark:text-base-400 truncate"
              >
                {space.unreadCount} unread
              </span>
            {/if}
          </div>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .sidebar-server-bar {
    /* contain + will-change = compositor-only */
    contain: layout style;
    will-change: transform, max-width;
    transition:
      max-width 400ms cubic-bezier(0.33, 1, 0.68, 1),
      transform 400ms cubic-bezier(0.33, 1, 0.68, 1),
      opacity 400ms ease;
  }
  /* Default: expanded (w-16) — no translate needed */
  .sidebar-server-bar.server-bar-expanded {
    transform: translateX(0);
    max-width: 64px;
    opacity: 1;
  }
  /* Wide (homepage): sits at position 0, full width */
  .sidebar-server-bar.server-bar-wide {
    transform: translateX(0);
    max-width: 256px;
    opacity: 1;
  }
  /* Collapsed: translate left by its own width (w-16 = 64px) so it slides behind the BigSidebar */
  .sidebar-server-bar.server-bar-collapsed {
    transform: translateX(-64px);
    max-width: 0;
    opacity: 0.4;
  }
  button.active {
    --avatar-ring: var(--color-accent-500);
  }
  button:not(.active) {
    --avatar-ring: transparent;
  }
  button:not(.active):hover {
    --avatar-ring: color-mix(in srgb, var(--color-base-500) 40%, transparent);
  }
</style>
