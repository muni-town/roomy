<script lang="ts">
  import { cdnImageUrl } from "$lib/utils.svelte";
  import SpaceAvatarShell from "@roomy/design/components/spaces/SpaceAvatar.svelte";

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

<SpaceAvatarShell
  src={imageUrl ? cdnImageUrl(imageUrl) : undefined}
  {id}
  {name}
  {size}
  {loading}
/>
