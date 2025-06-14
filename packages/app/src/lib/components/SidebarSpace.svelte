<script lang="ts">
  import ContextMenu from "./ContextMenu.svelte";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { navigate } from "$lib/utils.svelte";
  import TooltipPortal from "./TooltipPortal.svelte";
  import { page } from "$app/state";
  import { co } from "jazz-tools";
  import { Space, RoomyAccount } from "$lib/jazz/schema";

  type Props = {
    space: co.loaded<typeof Space> | null | undefined;
    hasJoined?: boolean;
    me: co.loaded<typeof RoomyAccount> | null | undefined;
  };

  const { space, hasJoined = true, me }: Props = $props();

  // Tooltip state
  let activeTooltip = $state("");
  let tooltipPosition = $state({ x: 0, y: 0 });

  let isActive = $derived(page.url.pathname.includes(space?.id || ""));

  function leaveSpace() {
    if (!space?.id || !me?.profile?.joinedSpaces || !space.members) return;

    // Remove the space from the user's joined spaces
    const spaceIndex = me.profile.joinedSpaces.findIndex(
      (s) => s?.id === space.id,
    );
    if (spaceIndex !== -1) {
      me.profile.joinedSpaces.splice(spaceIndex, 1);
    }

    const memberIndex = space.members.findIndex((m) => m?.id === me.id);
    if (memberIndex !== -1) {
      space.members.splice(memberIndex, 1);
    }

    // If the user is currently viewing this space, navigate to home
    if (isActive) {
      navigate("home");
    }
  }
</script>

<TooltipPortal
  text={activeTooltip}
  visible={!!activeTooltip}
  x={tooltipPosition.x}
  y={tooltipPosition.y}
/>
<ContextMenu
  menuTitle={space?.name}
  items={[
    {
      label: "Leave Space",
      icon: "mdi:exit-to-app",
      onselect: leaveSpace,
    },
  ]}
>
  <button
    onclick={() => navigate({ space: space?.id || "" })}
    value={space?.id}
    onmouseenter={(e: Event) => {
      activeTooltip = space?.name || "";
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      tooltipPosition = { x: rect.right + 8, y: rect.top + rect.height / 2 };
    }}
    onmouseleave={() => {
      activeTooltip = "";
    }}
    onblur={() => {
      activeTooltip = "";
    }}
    class={[
      "size-12 rounded-full relative group p-0.5",
      isActive &&
        "ring-0.5 ring-offset-0 ring-primary/30 border border-primary",
      "transition-all duration-200",
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
  </button>
</ContextMenu>
