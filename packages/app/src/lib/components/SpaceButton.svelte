<script lang="ts">
  import { co, Space } from "@roomy-chat/sdk";
  import { AvatarMarble } from "svelte-boring-avatars";

  let { space }: { space: co.loaded<typeof Space> | undefined | null } = $props();
</script>

<div class="relative flex flex-col items-center justify-center gap-2 max-w-42">
  {#if space?.imageUrl}
    <img
      src={space?.imageUrl}
      alt={space?.name || ""}
      class="size-24 object-cover rounded-full object-center bg-base-700 dark:bg-base-300"
    />
  {:else if space && space.id}
    <div class="size-24">
      <AvatarMarble name={space.id} size={96} />
    </div>
  {:else}
    <div class="size-24 bg-base-300 rounded-full"></div>
  {/if}

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
