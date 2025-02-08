<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  type Props = {
    handle: string;
    avatarUrl?: string;
    className?: string;
  };

  let { handle, avatarUrl, className }: Props = $props();
</script>

<Avatar.Root class={`w-8 aspect-square ${className}`}>
  <Avatar.Image src={avatarUrl} class="rounded-full" />
  <Avatar.Fallback>
    <AvatarBeam name={handle} />
  </Avatar.Fallback>
</Avatar.Root>
