<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarMarble } from "svelte-boring-avatars";

  type Props = {
    handle: string;
    avatarUrl?: string;
    className?: string;
  };

  const { handle, avatarUrl, className }: Props = $props();
</script>

<Avatar.Root class={`w-10 aspect-square ${className}`}>
  <Avatar.Image src={avatarUrl} class="rounded-full" />
  <Avatar.Fallback>
    <AvatarMarble name={handle} size={40} />
  </Avatar.Fallback>
</Avatar.Root>
