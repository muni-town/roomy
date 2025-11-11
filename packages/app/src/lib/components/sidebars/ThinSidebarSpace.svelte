<script lang="ts">
  import { navigate, navigateSync } from "$lib/utils.svelte";
  import { Tooltip } from "@fuxui/base";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { current, type SpaceMeta } from "$lib/queries.svelte";

  const space: SpaceMeta & { hasJoined?: boolean } = $props();

  let isActive = $derived(current.space?.id == space.id);
</script>

<Tooltip
  text={space.name}
  delayDuration={0}
  contentProps={{ side: "right", sideOffset: 5 }}
>
  {#snippet child({ props })}
    <a
      {...props}
      href={navigateSync({ space: space.handle || space.id })}
      class={[
        "size-10 rounded-full relative group",
        isActive
          ? "outline-4 outline-accent-500 cursor-default"
          : "cursor-pointer",
        "transition-all duration-200 bg-base-300",
      ]}
      onmousedown={() => {
        if (isActive) return;
        navigate({ space: space.handle || space.id });
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
          space.hasJoined == false && "filter grayscale",
        ]}
      >
        <SpaceAvatar imageUrl={space.avatar} id={space.id} size={40} />
      </div>
    </a>
  {/snippet}
</Tooltip>
