<script lang="ts">
  /***
   * Adapted from Fox UI AvatarGroup component by Flo-bit
   * https://github.com/flo-bit/ui-kit/blob/main/packages/core/src/lib/components/avatar/AvatarGroup.svelte
   */

  import { Avatar, type WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "@foxui/core";
  import { AvatarBeam } from "svelte-boring-avatars";

  let {
    users,
    ref = $bindable(null),

    avatarClass,
    imageClass,
    fallbackClass,

    class: className,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    avatarClass?: string;
    imageClass?: string;
    fallbackClass?: string;

    users: {
      src?: string;
      alt?: string;
      id?: string;
    }[];

    class?: string;
  } = $props();
</script>

<div
  class={cn("flex -space-x-2 overflow-hidden", className)}
  bind:this={ref}
  {...restProps}
>
  {#each users as user}
    <Avatar.Root
      class={[cn("size-8 border-base-50 border rounded-full", avatarClass)]}
    >
      <Avatar.Image src={user.src} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam name={user.id} size={30} />
      </Avatar.Fallback>
    </Avatar.Root>
    <!-- <Avatar
      src={user.src}
      alt={user.alt}
      fallback={user.fallback}
      class={cn("border-base-50 dark:border-base-950 border-2", avatarClass)}
      {imageClass}
      {fallbackClass}
    /> -->
  {/each}
</div>
