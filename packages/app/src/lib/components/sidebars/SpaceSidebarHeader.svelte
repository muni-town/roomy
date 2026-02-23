<script lang="ts">
  import { cn, toast } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import Popover from "$lib/components/ui/popover/Popover.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { getAppState } from "$lib/queries";
  import { peer, peerStatus } from "$lib/workers";
  import { newUlid } from "@roomy/sdk";

  import {
    IconChevronDown,
    IconShare,
    IconPlus,
    IconPencil,
    IconSettings,
    IconLogOut,
  } from "@roomy/design/icons";

  const app = getAppState();

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  async function leaveSpace() {
    const spaceDid = app.joinedSpace?.id;
    if (peerStatus.roomyState?.state !== "connected") return;
    if (!spaceDid || !peerStatus.roomyState.personalSpace) return;

    // Tell the space that we are leaving the member list
    await peer.sendEvent(spaceDid, {
      id: newUlid(),
      $type: "space.roomy.space.leaveSpace.v0",
    });

    // Remove the space from our personal space list
    await peer.sendEvent(peerStatus.roomyState.personalSpace, {
      id: newUlid(),
      $type: "space.roomy.space.personal.leaveSpace.v0",
      spaceDid: spaceDid,
    });

    navigate("home");
  }

  let popoverOpen = $state(false);
</script>

<div
  class="w-full pt-0.5 pb-1 px-2 h-fit flex mb-4 justify-between items-center"
>
  <Popover
    side="bottom"
    class="w-full"
    align="end"
    bind:open={popoverOpen}
    sideOffset={5}
  >
    {#snippet child({ props })}
      <button
        {...props}
        class="flex justify-between items-center mt-2 hover:bg-accent-200/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl p-2 w-full text-left transition-colors"
      >
        <div class="flex items-center gap-4 max-w-full">
          <SpaceAvatar
            imageUrl={app.joinedSpace?.avatar}
            id={app.joinedSpace?.id}
          />

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow"
          >
            {app.joinedSpace?.name ?? ""}
          </h1>
        </div>
        <IconChevronDown
          class={cn(
            "size-4 text-base-700 dark:text-base-300 transition-transform duration-200",
            popoverOpen && "rotate-180",
          )}
        />
      </button>
    {/snippet}
    <div class="flex flex-col items-start justify-stretch gap-2 w-[204px]">
      <Button
        onclick={() => {
          const url = new URL(page.url.href);
          url.pathname = `/${page.params.space}`;
          navigator.clipboard.writeText(url.href);
          toast.success("Invite link copied to clipboard");
        }}
        class="w-full"
      >
        <IconShare class="size-4" /> Invite
      </Button>

      {#if app.isSpaceAdmin}
        <Button
          class="w-full"
          href={`/${app.joinedSpace?.id}/new`}
          variant="secondary"
        >
          <IconPlus class="size-4" /> New
        </Button>
        <Button
          class="w-full"
          onclick={() => {
            isEditing = !isEditing;
            popoverOpen = false;
          }}
          variant="secondary"
        >
          <IconPencil class="size-4" />
          {isEditing ? "Finish editing" : "Edit Sidebar"}
        </Button>

        <Button
          class="w-full"
          href={`/${page.params.space}/settings`}
          variant="secondary"
        >
          <IconSettings class="size-4" /> Space settings
        </Button>
      {/if}

      <Button variant="red" class="w-full" onclick={leaveSpace}>
        <IconLogOut class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>
</div>
