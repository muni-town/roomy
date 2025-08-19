<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button, cn, Popover } from "@fuxui/base";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import {
    AllMembersComponent,
    isCurrentAccountSpaceAdmin,
    RoomyAccount,
    RoomyEntity,
  } from "@roomy-chat/sdk";
  import toast from "svelte-french-toast";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { joinSpace } from "../helper/joinSpace";
  import { user } from "$lib/user.svelte";
  import { blueskyLoginModalState } from "@fuxui/social";

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  let space = $derived(
    page.params?.space
      ? new CoState(RoomyEntity, page.params.space, {
          resolve: {
            components: true,
          },
        })
      : null,
  );
  let isAdmin = $state(false);
  $effect(() => {
    if (!space?.current) return;
    console.log(space.current.id);
    isCurrentAccountSpaceAdmin(space.current).then((b) => (isAdmin = b));
  });

  let members = $derived(
    new CoState(
      AllMembersComponent,
      space?.current?.components?.[AllMembersComponent.id],
    ),
  );

  let users = $derived(
    Object.values(members.current?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value),
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
      !users ||
      !users.length
    )
      return;

    // Remove the space from the user's joined spaces
    const spaceIndex = me.current.profile.joinedSpaces.findIndex(
      (s) => s?.id === space?.current?.id,
    );
    if (spaceIndex !== -1) {
      me.current.profile.joinedSpaces.splice(spaceIndex, 1);
    }

    const memberIndex = users.findIndex(
      (m) => m?.account?.id === me?.current?.id,
    );
    if (memberIndex !== -1 && users[memberIndex]) {
      users[memberIndex].softDeleted = true;
    }

    navigate("home");
  }

  let popoverOpen = $state(false);

  let hasJoinedSpace = $derived(
    me.current?.profile?.joinedSpaces?.some(
      (joinedSpace) => joinedSpace?.id === space?.current?.id,
    ),
  );
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
            imageUrl={space?.current?.imageUrl}
            id={space?.current?.id}
          />

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full flex-grow"
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
    <div class="flex flex-col items-start justify-stretch gap-2 w-[204px]">
      {#if hasJoinedSpace}
        <Button
          onclick={() => {
            navigator.clipboard.writeText(`${page.url.href}`);
            toast.success("Invite link copied to clipboard");
          }}
          class="w-full"
        >
          <Icon icon="lucide:share" class="size-4" /> Invite
        </Button>
      {:else if user.session}
        <Button
          onclick={() => {
            joinSpace(space?.current, me.current);
            popoverOpen = false;
          }}
          class="w-full"
        >
          <Icon icon="lucide:plus" class="size-4" /> Join Space
        </Button>
      {:else}
        <Button
          onclick={() => {
            blueskyLoginModalState.open = true;
            popoverOpen = false;
          }}
          class="w-full"
        >
          <Icon icon="lucide:user" class="size-4" /> Login to join space
        </Button>
      {/if}

      {#if isAdmin}
        <Button
          class="w-full"
          href={`/${space?.current?.id}/new`}
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
          href={`/${space?.current?.id}/settings`}
          variant="secondary"
        >
          <Icon icon="lucide:settings" class="size-4" /> Space settings
        </Button>
      {/if}

      {#if hasJoinedSpace}
        <Button variant="red" class="w-full" onclick={leaveSpace}>
          <Icon icon="lucide:log-out" class="size-4" /> Leave Space
        </Button>
      {/if}
    </div>
  </Popover>
</div>
