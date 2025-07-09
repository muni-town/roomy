<script lang="ts">
  import { AvatarMarble } from "svelte-boring-avatars";
  import { navigateSync } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { co } from "jazz-tools";
  import { Space } from "@roomy-chat/sdk";
  import { Tooltip } from "@fuxui/base";

  type Props = {
    space: co.loaded<typeof Space> | null | undefined;
    hasJoined?: boolean;
  };

  const { space, hasJoined = true }: Props = $props();

  let isActive = $derived(space?.id && page.url.pathname.includes(space?.id || ""));
</script>

<Tooltip
  text={space?.name}
  delayDuration={0}
  contentProps={{ side: "right", sideOffset: 5 }}
>
  {#snippet child({ props })}
    <a
      {...props}
      href={navigateSync({ space: space?.id || "" })}
      class={[
        "size-10 rounded-full relative group cursor-pointer",
        isActive && "outline-4 outline-accent-500",
        "transition-all duration-200 bg-base-300",
      ]}
    >
      <div
        class={[
          "flex items-center justify-center overflow-hidden",
          !hasJoined && "opacity-50",
        ]}
      >
        {#if space?.imageUrl}
          <img
            src={space?.imageUrl}
            alt={space?.name || ""}
            class="size-10 object-cover rounded-full object-center"
          />
        {:else if space && space.id}
          <div class="size-10">
            <AvatarMarble name={space.id} size={40} />
          </div>
        {:else}
          <div class="size-10 bg-base-300 rounded-full"></div>
        {/if}
      </div>
    </a>
  {/snippet}
</Tooltip>
