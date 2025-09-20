<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button, cn, Popover } from "@fuxui/base";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import toast from "svelte-french-toast";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import { ulid } from "ulidx";

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  async function leaveSpace() {
    if (!current.space || !backendStatus.personalStreamId) return;
    await backend.sendEvent(backendStatus.personalStreamId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.leave.0",
        data: {
          spaceId: current.space.id,
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
            imageUrl={current.space?.avatar}
            id={current.space?.id}
          />

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full flex-grow"
          >
            {current.space?.name ?? ""}
          </h1>
        </div>
        <Icon
          icon="lucide:chevron-down"
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
            `${page.url.href}?name=${encodeURIComponent(current.space?.name ?? "")}&avatar=${encodeURIComponent(current.space?.avatar ?? "")}`,
          );
          toast.success("Invite link copied to clipboard");
        }}
        class="w-full"
      >
        <Icon icon="lucide:share" class="size-4" /> Invite
      </Button>

      {#if current.isSpaceAdmin}
        <Button
          class="w-full"
          href={`/${current.space?.id}/new`}
          variant="secondary"
        >
          <Icon icon="lucide:plus" class="size-4" /> New Object
        </Button>
        <Button
          class="w-full"
          onclick={() => {
            isEditing = !isEditing;
            popoverOpen = false;
          }}
          variant="secondary"
        >
          <Icon icon="lucide:pencil" class="size-4" />
          {isEditing ? "Finish editing" : "Edit objects"}
        </Button>

        <Button
          class="w-full"
          href={`/${current.space?.id}/settings`}
          variant="secondary"
        >
          <Icon icon="lucide:settings" class="size-4" /> Space settings
        </Button>
      {/if}

      <Button variant="red" class="w-full" onclick={leaveSpace}>
        <Icon icon="lucide:log-out" class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>
</div>
