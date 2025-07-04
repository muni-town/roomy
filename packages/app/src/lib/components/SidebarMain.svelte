<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button, cn, Popover } from "@fuxui/base";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-svelte";
  import {
    RoomyAccount,
    Space,
  } from "@roomy-chat/sdk";
  import { AvatarMarble } from "svelte-boring-avatars";
  import toast from "svelte-french-toast";
  import SidebarObjectList from "./SidebarObjectList.svelte";

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

    // If the user is currently viewing this space, navigate to home
    if (page.url.pathname.includes(space?.current?.id || "XXX")) {
      navigate("home");
    }
  }

  let popoverOpen = $state(false);

  $inspect(space?.current?.rootFolder?.childrenIds);
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
            {space?.current?.name && space?.current?.name !== "Unnamed"
              ? space.current?.name
              : ""}
          </h1>
        </div>
        <Icon
            icon="lucide:chevron-down"
            class={cn("size-4 text-base-700 dark:text-base-300 transition-transform duration-200", popoverOpen && "rotate-180")}
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
      <Button variant="red" class="w-full" onclick={leaveSpace}>
        <Icon icon="lucide:log-out" class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>
</div>

<!-- {#if isSpaceAdmin(space?.current)}
  <menu class="p-0 w-full justify-between px-2 flex flex-col gap-2 mb-4">
    <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
      {#snippet dialogTrigger()}
        <Button
          variant="secondary"
          title="Create Channel"
          class="w-full justify-start"
        >
          <Icon icon="basil:comment-plus-solid" class="size-6" />
          Create Channel
        </Button>
      {/snippet}

      <div class="max-h-[80vh] overflow-y-auto">
        <form
          id="createChannel"
          class="flex flex-col gap-4"
          onsubmit={createChannelSubmit}
        >
          <label class="dz-input w-full">
            <span class="dz-label">Name</span>
            <input
              bind:value={newChannelName}
              use:focusOnRender
              placeholder={newChannelType === "feeds"
                ? "AT Proto Feeds"
                : "General"}
              type="text"
              required
            />
          </label>
          <label class="dz-select w-full">
            <span class="dz-label">Type</span>
            <select bind:value={newChannelType}>
              <option value="chat">💬 Chat Channel</option>
              <option value="feeds">📡 Feeds Channel</option>
              <option value="links">🔗 Links Channel</option>
            </select>
          </label>
          {#if newChannelType === "feeds"}
            <div class="text-sm text-base-content/70 p-2 bg-base-200 rounded">
              <Icon icon="information-circle" class="inline mr-1" />
              This channel will automatically display AT Proto feed posts instead
              of regular chat messages.
            </div>
          {:else if newChannelType === "links"}
            <div class="text-sm text-base-content/70 p-2 bg-base-200 rounded">
              <Icon icon="information-circle" class="inline mr-1" />
              This channel will automatically discover and display all links shared
              across channels in this space.
            </div>
          {/if}
          {#if newChannelType === "feeds"}
          {/if}
          <label class="dz-select w-full">
            <span class="dz-label">Category</span>
            <select bind:value={newChannelCategory}>
              <option value={undefined}>None</option>
              {#each space?.current?.categories?.filter((category) => !category?.softDeleted) ?? [] as category}
                <option value={category}>{category?.name}</option>
              {/each}
            </select>
          </label>
          <Button type="submit" class="w-full justify-start">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create {newChannelType === "feeds"
              ? "Feeds"
              : newChannelType === "links"
                ? "Links"
                : "Chat"} Channel
          </Button>
        </form>
      </div>
    </Dialog>

    <Dialog title="Create Category" bind:isDialogOpen={showNewCategoryDialog}>
      {#snippet dialogTrigger()}
        <Button
          variant="secondary"
          class="w-full justify-start"
          title="Create Category"
        >
          <Icon icon="basil:folder-plus-solid" class="size-6" />
          Create Category
        </Button>
      {/snippet}

      <form
        id="createCategory"
        class="flex flex-col gap-4"
        onsubmit={createCategorySubmit}
      >
        <label class="dz-input w-full">
          <span class="dz-label">Name</span>
          <input
            bind:value={newCategoryName}
            use:focusOnRender
            placeholder="Discussions"
            type="text"
            required
          />
        </label>
        <Button.Root class="dz-btn dz-btn-primary">
          <Icon icon="basil:add-outline" font-size="1.8em" />
          Create Category
        </Button.Root>
      </form>
    </Dialog>
  </menu>
{/if}

<div class="py-2 w-full px-2">
  <SidebarChannelList {sidebarItems} space={space.current} me={me.current} />
</div> -->
<div class="py-2 w-full px-2">
  <SidebarObjectList childrenIds={space?.current?.rootFolder?.childrenIds} />
</div>
