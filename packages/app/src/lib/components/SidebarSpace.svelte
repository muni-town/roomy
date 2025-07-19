<script lang="ts">
  import { navigate, navigateSync } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { co } from "jazz-tools";
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { Tooltip } from "@fuxui/base";
  import SpaceAvatar from "./SpaceAvatar.svelte";

  type Props = {
    space: co.loaded<typeof RoomyEntity> | null | undefined;
    hasJoined?: boolean;
  };

  const { space, hasJoined = true }: Props = $props();

  let isActive = $derived(
    space?.id && page.url.pathname.includes(space?.id || ""),
  );
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
        "size-10 rounded-full relative group",
        isActive ? "outline-4 outline-accent-500 cursor-default" : "cursor-pointer",
        "transition-all duration-200 bg-base-300",
      ]}
      onmousedown={() => {
        if (isActive) return;
        navigate({ space: space?.id || "" });
      }}
      onclick={(e) => {
        if (!isActive) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        class={[
          "flex items-center justify-center overflow-hidden",
          !hasJoined && "filter grayscale",
        ]}
      >
        <SpaceAvatar imageUrl={space?.imageUrl} id={space?.id} size={40} />
      </div>
    </a>
  {/snippet}
</Tooltip>
