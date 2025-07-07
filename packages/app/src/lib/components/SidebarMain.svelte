<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button, cn, Popover } from "@fuxui/base";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-svelte";
  import { isSpaceAdmin, RoomyAccount, Space } from "@roomy-chat/sdk";
  import { AvatarMarble } from "svelte-boring-avatars";
  import toast from "svelte-french-toast";
  import SidebarObjectList from "./SidebarObjectList.svelte";
  import CreateObjectModal from "./modals/CreateObjectModal.svelte";

  let space = $derived(
    page.params?.space
      ? new CoState(Space, page.params.space, {
          resolve: {
            rootFolder: {
              childrenIds: true,
            },
          },
        })
      : null,
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        roomyInbox: {
          $each: true,
          $onError: null,
        },
      },
      root: {
        lastRead: true,
      },
    },
  });

  function leaveSpace() {
    if (
      !space?.current?.id ||
      !me?.current?.profile?.joinedSpaces ||
      !space.current.members
    )
      return;

    // Remove the space from the user's joined spaces
    const spaceIndex = me.current.profile.joinedSpaces.findIndex(
      (s) => s?.id === space?.current?.id,
    );
    if (spaceIndex !== -1) {
      me.current.profile.joinedSpaces.splice(spaceIndex, 1);
    }

    const memberIndex = space.current.members.findIndex(
      (m) => m?.id === me?.current?.id,
    );
    if (memberIndex !== -1) {
      space.current.members.splice(memberIndex, 1);
    }

    navigate("home");
  }

  let popoverOpen = $state(false);

  let showNewObjectDialog = $state(false);
</script>

<!-- Header -->
<div
  class="w-full pt-0.5 pb-1 px-2 h-fit flex mb-4 justify-between items-center"
>
  <Popover side="bottom" class="w-full" align="end" bind:open={popoverOpen}>
    {#snippet child({ props })}
      <button
        {...props}
        class="flex justify-between items-center mt-2 border border-base-800/10 dark:border-base-100/5 hover:bg-base-300/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl bg-base-200 dark:bg-base-900/50 p-2 w-full text-left"
      >
        <div class="flex items-center gap-4">
          {#if space?.current?.imageUrl}
            <img
              src={space?.current?.imageUrl}
              alt={space?.current?.name || ""}
              class="size-8 object-cover rounded-full object-center bg-base-200 dark:bg-base-900"
            />
          {:else if space?.current && space?.current.id}
            <div class="size-8">
              <AvatarMarble name={space?.current.id} size={32} />
            </div>
          {:else}
            <div class="size-8 bg-base-300 rounded-full"></div>
          {/if}

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate flex-grow"
          >
            {space?.current?.name ? space.current?.name : ""}
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
    <div class="flex flex-col items-start justify-stretch gap-2">
      <Button
        onclick={() => {
          navigator.clipboard.writeText(`${page.url.href}`);
          toast.success("Invite link copied to clipboard");
        }}
      >
        <Icon icon="lucide:share" class="size-4" /> Invite members
      </Button>

      {#if isSpaceAdmin(space?.current)}
        <Button
          class="w-full"
          onclick={() => {
            showNewObjectDialog = true;
            popoverOpen = false;
          }}
        >
          <Icon icon="lucide:plus" class="size-4" /> New Object
        </Button>
      {/if}
      <Button variant="red" class="w-full" onclick={leaveSpace}>
        <Icon icon="lucide:log-out" class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>
</div>

<CreateObjectModal bind:open={showNewObjectDialog} space={space?.current} />

<div class="py-2 w-full px-2">
  <SidebarObjectList childrenIds={space?.current?.rootFolder?.childrenIds} />
</div>
