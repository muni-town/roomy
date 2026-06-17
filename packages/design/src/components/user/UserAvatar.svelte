<script lang="ts">
  import { Avatar, type WithoutChildrenOrChild } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  let {
    src,
    name = "unknown",
    size = 32,
    class: className,
    ...restProps
  }: WithoutChildrenOrChild<Avatar.RootProps> & {
    /** Image URL for the avatar. Falls back to a generated boring avatar on error. */
    src?: string;
    /** Seed for the generated boring avatar (e.g. DID, handle). */
    name?: string;
    /** Size of the boring avatar in pixels when the image fails. */
    size?: number;
    /** Additional classes for the root element. */
    class?: string;
  } = $props();
</script>

<Avatar.Root class={className} {...restProps}>
  <Avatar.Image {src} class="rounded-full" />
  <Avatar.Fallback>
    <AvatarBeam {name} {size} />
  </Avatar.Fallback>
</Avatar.Root>
