<script lang="ts">
  import { cdnImageUrl } from "$lib/utils.svelte";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { IconLoading } from "@roomy/design/icons";
  import { fade } from "svelte/transition";

  let {
    imageUrl,
    id,
    name,
    size = 32,
    loading,
  }: {
    imageUrl?: string;
    id?: string;
    name?: string;
    size?: number;
    loading?: boolean;
  } = $props();
</script>

<div
  class={`rounded-full relative overflow-hidden bg-base-200 dark:bg-base-900 shrink-0 ${loading ? "opacity-70" : ""}`}
  style={`width: ${size}px; height: ${size}px;`}
>
  {#if imageUrl}
    <img
      src={cdnImageUrl(imageUrl)}
      alt={name}
      class="object-cover object-center h-full w-full"
    />
  {:else if id}
    <!-- Ensure a rerender on id change -->
    {#key id}
      <AvatarMarble name={id} {size} />
    {/key}
  {/if}
  {#if loading}
    <div
      transition:fade={{ duration: 500 }}
      class="z-10 absolute inset-[-5px] flex items-center justify-center"
    >
      <IconLoading
        font-size="1.8em"
        class="text-white stroke-0"
        style="animation: spin 1.3s  cubic-bezier(0.5, 0.2, 0.5, 0.8) infinite; stroke-linecap: round;"
      />
    </div>
  {/if}
</div>
