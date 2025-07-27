<script lang="ts">
  import { AvatarMarble } from "svelte-boring-avatars";

  let {
    imageUrl,
    id,
    name,
    size = 32,
  }: {
    imageUrl?: string;
    id?: string;
    name?: string;
    size?: number;
  } = $props();
</script>

<div
  class="rounded-full overflow-hidden bg-base-200 dark:bg-base-900 shrink-0"
  style={`width: ${size}px; height: ${size}px;`}
>
  {#if imageUrl}
    <img
      src={imageUrl}
      alt={name}
      class="object-cover object-center h-full w-full"
    />
  {:else if id}
    <AvatarMarble name={id} {size} />
  {/if}
</div>
