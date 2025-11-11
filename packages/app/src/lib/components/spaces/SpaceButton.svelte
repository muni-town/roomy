<script lang="ts">
  import SpaceAvatar from "./SpaceAvatar.svelte";
  import type { SpaceMeta } from "$lib/queries.svelte";

  let { space }: { space: SpaceMeta | undefined } = $props();
</script>

<div class="relative flex flex-col items-center justify-start gap-2 max-w-42">
  <SpaceAvatar imageUrl={space?.avatar} id={space?.id} size={96} />

  <span class="text-lg font-semibold text-center">{space?.name}</span>

  {#if space?.description}
    <p
      class="text-sm text-base-500 dark:text-base-400 max-w-full text-center line-clamp-3"
    >
      {space?.description}
    </p>
  {/if}

  {#if space}
    <a
      href={`/${space.handle || space.id}`}
      class="absolute -inset-2 hover:bg-accent-500/5 rounded-xl"
    >
      <span class="sr-only">Go to {space.name}</span>
    </a>
  {/if}
</div>
