<script lang="ts">
  import { co, Space } from "@roomy-chat/sdk";
  import SpaceAvatar from "./SpaceAvatar.svelte";

  let { space }: { space: co.loaded<typeof Space> | undefined | null } = $props();
</script>

<div class="relative flex flex-col items-center justify-start gap-2 max-w-42">
  <SpaceAvatar imageUrl={space?.imageUrl} id={space?.id} size={96} />

  <span class="text-lg font-semibold">{space?.name}</span>

  {#if space?.description || Math.random() < 0.5}
    <p class="text-sm text-base-500 dark:text-base-400 max-w-full text-center line-clamp-3">
      {space?.description ?? "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."}
    </p>
  {/if}

  {#if space}
    <a href={`/${space.id}`} class="absolute -inset-2 hover:bg-accent-500/5 rounded-xl">
      <span class="sr-only">Go to {space.name}</span>
    </a>
  {/if}
</div>
