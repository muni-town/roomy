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
  }: {
    /** When true, render at full sidebar width with space names next to avatars */
    wide?: boolean;
  } = $props();

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  const joinedSpaces = $derived(
    (spacesQuery.data?.spaces ?? []).filter((s) => s.isMember),
  );

  const currentSpaceId = $derived(page.params.space);

  function navigateToSpace(spaceId: string) {
    goto(`/${spaceId}`);
  }
</script>

<div
  class={[
    "flex flex-col py-1 bg-base-100/50 dark:bg-base-950 min-h-0 gap-2",
    wide
      ? "w-64 border-r border-base-950/5 dark:border-base-300/10"
      : "w-16 items-center",
  ].join(" ")}
>
  <!-- Home button -->
  <div class={wide ? "mx-1.75" : "flex justify-center"}>
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
        <span class="text-sm font-medium truncate">Home</span>
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
          "transition-all cursor-pointer opacity-90 hover:opacity-100 my-0.5",
          wide
            ? "flex items-center gap-3 h-12 px-1.5 rounded-lg text-left hover:bg-base-300/30 dark:hover:bg-base-800/30"
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
        </div>
        {#if wide}
          <span
            class="text-sm font-medium truncate text-base-700 dark:text-base-300"
          >
            {space.name ?? "Unnamed Space"}
          </span>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
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
