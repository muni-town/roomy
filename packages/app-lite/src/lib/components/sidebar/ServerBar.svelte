<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME, type DndEvent } from "svelte-dnd-action";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconMasonryGrid, IconPlus, IconSearch } from "@roomy/design/icons";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import { serverBar } from "$lib/components/layout/server-bar.svelte";
  import { cache } from "@roomy-space/sdk";
  import { queryClient } from "$lib/client";
  import { reorderSpaces } from "$lib/mutations/space";

  const { queryKey } = cache;

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

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  // Search feature flag: gates the Explore (cross-space search) button.
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  const joinedSpaces = $derived(
    (spacesQuery.data?.spaces ?? []).filter((s) => s.isMember),
  );

  // ── Drag-and-drop reorder (long-press to arm) ─────────────────────────
  // The dndzone stays mounted with dragDisabled=true so plain clicks still
  // navigate. A 500ms press on a space arms dragging: the zone flips to
  // enabled and we dispatch a synthetic mousedown so the library picks up
  // the in-progress gesture. Touch uses the library's own delayTouchStart.

  type SpaceDndItem = {
    id: string;
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  };

  let draftOrder = $state<SpaceDndItem[] | null>(null);
  let dragArmed = $state(false);
  let dragStarted = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTarget: HTMLElement | null = null;
  let suppressClickUntil = 0;

  const displaySpaces: (typeof joinedSpaces[number] & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  })[] = $derived.by(() => {
    if (!draftOrder) return joinedSpaces;
    const byId = new Map(joinedSpaces.map((s) => [s.id, s]));
    return draftOrder
      .map((d) => {
        const s = byId.get(d.id);
        if (!s) return null;
        if (d[SHADOW_ITEM_MARKER_PROPERTY_NAME]) {
          return { ...s, [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true };
        }
        return s;
      })
      .filter((s): s is NonNullable<typeof s> => s != null);
  });

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressTarget = null;
  }

  function handleGlobalPointerUp() {
    // Released before the long-press elapsed → cancel the pending timer.
    if (longPressTimer) {
      clearLongPress();
      return;
    }
    // Released after arming but before a drag started → disarm the zone so
    // the next plain click doesn't start a drag.
    if (dragArmed && !dragStarted) {
      dragArmed = false;
    }
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === "touch") return; // touch uses delayTouchStart
    if (e.button !== 0) return;
    const target = (e.currentTarget as HTMLElement).closest("button");
    if (!target) return;
    clearLongPress();
    longPressTarget = target;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!longPressTarget) return;
      // Arm the zone, then hand the in-progress gesture to the library by
      // dispatching a fresh mousedown on the same element. The library's
      // handleMouseDown records the current position and starts watching
      // for movement; the user's finger is still down, so the next mousemove
      // crosses the 3px threshold and starts the drag.
      dragArmed = true;
      const el = longPressTarget;
      longPressTarget = null;
      requestAnimationFrame(() => {
        // The user may have released before the frame; handleGlobalPointerUp
        // already disarmed the zone, so the synthetic mousedown is a no-op.
        if (!dragArmed) return;
        el.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: e.clientX,
            clientY: e.clientY,
          }),
        );
      });
    }, 500);
    // One-shot release handler: covers both the pre-elapse cancel and the
    // armed-but-no-drag disarm, regardless of where the pointer is.
    window.addEventListener("pointerup", handleGlobalPointerUp, { once: true });
  }

  function handleConsider(e: CustomEvent<DndEvent<SpaceDndItem>>) {
    if (e.detail.info.trigger === "dragStarted") dragStarted = true;
    draftOrder = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<DndEvent<SpaceDndItem>>) {
    const next = e.detail.items;
    // Drop the draft: the optimistic cache update below reorders
    // spacesQuery.data, which is the single source of truth for the list.
    draftOrder = null;
    dragArmed = false;
    dragStarted = false;
    // The browser fires a click after the drop mouseup; if the pointer is
    // over another space's button that click would navigate. Suppress
    // clicks briefly after a real drag.
    suppressClickUntil = Date.now() + 300;
    const orderedIds = next.map((d) => d.id);
    const currentIds = joinedSpaces.map((s) => s.id);
    if (orderedIds.join(",") === currentIds.join(",")) return;

    // Optimistic: reorder the cached getSpaces response immediately so both
    // the server bar and the homepage cards reflect the new order without
    // waiting for the WS invalidation round-trip.
    const key = queryKey("space.roomy.space.getSpaces", { includeLeft: "true" });
    queryClient.setQueryData<{ spaces: typeof joinedSpaces }>(key, (existing) => {
      if (!existing) return existing;
      const byId = new Map(existing.spaces.map((s) => [s.id, s]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((s): s is NonNullable<typeof s> => s != null);
      const rest = existing.spaces.filter((s) => !orderedIds.includes(s.id));
      return { spaces: [...reordered, ...rest] };
    });

    void reorderSpaces(orderedIds).catch(() => {
      // On failure the WS invalidation (or a refetch) restores the server
      // order; the optimistic cache entry is stale until then.
      queryClient.invalidateQueries({ queryKey: key });
    });
  }

  const currentSpaceId = $derived(page.params.space);
  const onHome = $derived(page.url.pathname === "/");
  const onExplore = $derived(page.url.pathname === "/explore");

  function navigateToSpace(spaceId: string) {
    // A click right after a drag drop is the browser's synthetic click, not
    // a navigation intent — ignore it.
    if (Date.now() < suppressClickUntil) return;
    const destination = spaceNavigation.get(spaceId);
    if (destination?.kind === "room") {
      goto(`/${spaceId}/${destination.id}`);
    } else {
      goto(`/${spaceId}`);
    }
    // Close the space selector overlay once a space has been chosen so the
    // newly selected space's channels (BigSidebar) are revealed underneath.
    serverBar.expanded = false;
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
  class={[
    "flex flex-col py-1 bg-base-50/50 dark:bg-base-950 min-h-0 gap-2 overflow-hidden relative z-10 sidebar-server-bar h-full",
    wide
      ? "w-64"
      : "w-16 items-center",
    animClass,
  ].join(" ")}
>
  <!-- Home button -->
  <div class={wide ? "mx-2.5" : "flex justify-center"}>
    <Button
      href="/"
      variant="ghost"
      data-current={onHome}
      class={[
        "p-0 rounded-xl",
        wide
          ? "flex items-center gap-4.5 h-9 pl-3.5 pr-2 w-full justify-start [&_svg]:size-5"
          : "size-12 [&_svg]:size-6",
      ].join(" ")}
      aria-label="Directory"
      title="Directory"
    >
      <IconMasonryGrid />
      {#if wide}
        <span class="text-sm font-normal truncate">Directory</span>
      {/if}
    </Button>
  </div>

  <!-- Explore (cross-space search) button — gated on the `search` feature flag -->
  {#if searchEnabled}
    <div class={wide ? "mx-2.5" : "flex justify-center"}>
      <Button
        href="/explore"
        variant="ghost"
        data-current={onExplore}
        class={[
          "p-0 rounded-xl",
          wide
            ? "flex items-center gap-4.5 h-9 pl-3.5 pr-2 w-full justify-start [&_svg]:size-5"
            : "size-12 [&_svg]:size-6",
        ].join(" ")}
        aria-label="Explore"
        title="Explore"
      >
        <IconSearch />
        {#if wide}
          <span class="text-sm font-normal truncate">Explore</span>
        {/if}
      </Button>
    </div>
  {/if}

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
      "flex flex-col overflow-y-auto flex-1 gap-0 w-full",
      wide ? "" : "items-center",
    ].join(" ")}
  >
    <div
      class={[
        "flex flex-col gap-0 w-full",
        wide ? "" : "items-center",
      ].join(" ")}
      use:dndzone={{
        items: displaySpaces.map((s) => ({
          id: s.id,
          ...(s[SHADOW_ITEM_MARKER_PROPERTY_NAME] && {
            [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true,
          }),
        })),
        type: "space",
        dragDisabled: !dragArmed,
        delayTouchStart: 500,
        dropTargetClasses: ["bg-accent-500/10", "rounded"],
        dropTargetStyle: {
          outline: "2px solid var(--color-accent-500/30)",
        },
      }}
      onconsider={handleConsider}
      onfinalize={handleFinalize}
    >
      {#each displaySpaces as space (space[SHADOW_ITEM_MARKER_PROPERTY_NAME] ? `shadow-${space.id}` : space.id)}
        <button
          onclick={() => navigateToSpace(space.id)}
          onpointerdown={handlePointerDown}
          class={[
            "transition-[opacity,background-color] cursor-pointer opacity-90 hover:opacity-100 my-0",
            wide
              ? "flex items-center gap-3 h-10 w-full px-4.5 text-left hover:bg-base-300/30 dark:hover:bg-base-800/30"
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
            size={wide ? 32 : 48}
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
                class="text-sm font-normal truncate text-base-700 dark:text-base-300 hover:text-black dark:hover:text-white"
              >
                {space.name ?? "Unnamed Space"}
              </span>
              <!-- {#if space.unreadCount > 0}
                <span
                  class="text-xs text-base-500 dark:text-base-400 truncate"
                >
                  {space.unreadCount} unread
                </span>
              {/if} -->
            </div>
          {/if}
        </button>
      {/each}
    </div>

    <!-- New Space button -->
    <button
      onclick={() => goto("/new")}
      class={[
        "transition-[opacity,background-color] cursor-pointer opacity-70 hover:opacity-100 my-0",
        wide
          ? "flex items-center gap-3 h-10 w-full px-4.5 text-left hover:bg-base-300/30 dark:hover:bg-base-800/30"
          : "relative flex items-center justify-center size-12",
      ].join(" ")}
      title="New Space"
    >
      <div
        class={[
          "flex items-center justify-center rounded-xl border-2 border-dashed border-base-300 dark:border-base-600 text-base-400 dark:text-base-500 hover:text-accent-500 hover:border-accent-500 transition-colors",
          wide ? "shrink-0 size-8" : "size-12",
        ].join(" ")}
      >
        <IconPlus class="size-5" />
      </div>
      {#if wide}
        <span class="text-sm font-normal truncate text-base-500 dark:text-base-400">
          New Space
        </span>
      {/if}
    </button>
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
