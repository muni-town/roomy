<script lang="ts">
  import { navigate, navigateSync } from "$lib/utils.svelte";
  import Tooltip from "@roomy/design/components/helper/Tooltip.svelte";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { getAppState, type SpaceMeta } from "$lib/queries";
  const app = getAppState();

  const space: SpaceMeta & { hasJoined?: boolean } = $props();

  let isActive = $derived(app.joinedSpace?.id == space.id);
</script>

<Tooltip tip={space.name || ""} contentProps={{ side: "right", sideOffset: 5 }}>
  {#snippet trigger(props)}
    <a
      {...props}
      href={navigateSync({ space: space.handle || space.id })}
      class={[
        "size-10 rounded-full relative group outline-2 ",
        isActive
          ? "outline-accent-600 cursor-default"
          : "outline-base-400 cursor-pointer",
        "transition-all duration-200 bg-base-300 hover:brightness-105",
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
        <SpaceAvatar
          imageUrl={space.avatar}
          id={space.id}
          size={40}
          loading={space.backfill_status !== "idle"}
        />
      </div>
    </a>
  {/snippet}
</Tooltip>
