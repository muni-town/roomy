<script lang="ts">
  import { Button, cn, Popover, toast } from "@fuxui/base";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries";
  import { backend, backendStatus } from "$lib/workers";
  import { newUlid } from "$lib/schema";

  import IconLucideChevronDown from "~icons/lucide/chevron-down";
  import IconLucideShare from "~icons/lucide/share";
  import IconLucidePlus from "~icons/lucide/plus";
  import IconLucidePencil from "~icons/lucide/pencil";
  import IconLucideSettings from "~icons/lucide/settings";
  import IconLucideLogOut from "~icons/lucide/log-out";

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  async function leaveSpace() {
    const spaceId = current.joinedSpace?.id;
    if (backendStatus.authState?.state !== "authenticated") return;
    if (!spaceId || !backendStatus.authState.personalStream) return;

    // Tell the space that we are leaving the member list
    await backend.sendEvent(spaceId, {
      ulid: newUlid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.leave.v0",
        data: undefined,
      },
    });

    // Remove the space from our personal space list
    await backend.sendEvent(backendStatus.authState.personalStream, {
      ulid: newUlid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.personal.leaveSpace.v0",
        data: {
          spaceId: spaceId,
        },
      },
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
        class="flex justify-between items-center mt-2 border border-base-800/10 dark:border-base-100/5 hover:bg-base-300/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl bg-base-200 dark:bg-base-900/50 p-2 w-full text-left"
      >
        <div class="flex items-center gap-4 max-w-full">
          <SpaceAvatar
            imageUrl={current.joinedSpace?.avatar}
            id={current.joinedSpace?.id}
          />

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full flex-grow"
          >
            {current.joinedSpace?.name ?? ""}
          </h1>
        </div>
        <IconLucideChevronDown
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
          navigator.clipboard.writeText(
            `${page.url.href}?name=${encodeURIComponent(current.joinedSpace?.name ?? "")}&avatar=${encodeURIComponent(current.joinedSpace?.avatar ?? "")}`,
          );
          toast.success("Invite link copied to clipboard");
        }}
        class="w-full"
      >
        <IconLucideShare class="size-4" /> Invite
      </Button>

      {#if current.isSpaceAdmin}
        <Button
          class="w-full"
          href={`/${current.joinedSpace?.id}/new`}
          variant="secondary"
        >
          <IconLucidePlus class="size-4" /> New
        </Button>
        <Button
          class="w-full"
          onclick={() => {
            isEditing = !isEditing;
            popoverOpen = false;
          }}
          variant="secondary"
        >
          <IconLucidePencil class="size-4" />
          {isEditing ? "Finish editing" : "Edit Sidebar"}
        </Button>

        <Button
          class="w-full"
          href={`/${page.params.space}/settings`}
          variant="secondary"
        >
          <IconLucideSettings class="size-4" /> Space settings
        </Button>
      {/if}

      <Button variant="red" class="w-full" onclick={leaveSpace}>
        <IconLucideLogOut class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>
</div>
