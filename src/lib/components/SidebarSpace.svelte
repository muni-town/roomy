<script lang="ts">
  import type { Space, Roomy } from "@roomy-chat/sdk";

  import ContextMenu from "./ContextMenu.svelte";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { ToggleGroup } from "bits-ui";
  import { navigate } from "$lib/utils.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { Image } from "@roomy-chat/sdk";
  import TooltipPortal from "./TooltipPortal.svelte";
  import { g } from "$lib/global.svelte";

  type Props = {
    space: Space;
    i: number;
  };

  const { space, i }: Props = $props();

  // Tooltip state
  let activeTooltip = $state("");
  let tooltipPosition = $state({ x: 0, y: 0 });

  const spaceImage = derivePromise(null, async () => {
    if (space.image && g.roomy) {
      return (await g.roomy.open(Image, space.image)) as Image;
    }
  });
</script>

<TooltipPortal
  text={activeTooltip}
  visible={!!activeTooltip}
  x={tooltipPosition.x}
  y={tooltipPosition.y}
/>
<ContextMenu
  menuTitle={space.name}
  items={[
    {
      label: "Leave Space",
      icon: "mdi:exit-to-app",
      onselect: () => {
        g.roomy?.spaces.remove(i);
        g.roomy?.commit();
      },
    },
  ]}
>
  <ToggleGroup.Item
    onclick={() =>
      navigate({ space: space.handles((x) => x.get(0)) || space.id })}
    value={space.id}
    onmouseenter={(e: Event) => {
      activeTooltip = space.name;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      tooltipPosition = { x: rect.right + 8, y: rect.top + rect.height / 2 };
    }}
    onmouseleave={() => {
      activeTooltip = "";
    }}
    class="dz-btn dz-btn-ghost size-14 data-[state=on]:border-primary relative group p-0.5"
  >
    <div class="flex items-center justify-center overflow-hidden">
      {#if spaceImage.value?.uri}
        <img
          src={spaceImage.value?.uri}
          alt={space.name}
          class="w-10 h-10 object-cover rounded-full object-center"
        />
      {:else if space && space.id}
        <div class="w-10 h-10">
          <AvatarMarble name={space.id} />
        </div>
      {:else}
        <div class="w-10 h-10 bg-base-300 rounded-full"></div>
      {/if}
    </div>
  </ToggleGroup.Item>
</ContextMenu>
