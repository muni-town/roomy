<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button } from "bits-ui";
  import { navigate, Toggle } from "$lib/utils.svelte";
  import SpaceSettingsDialog from "$lib/components/SpaceSettingsDialog.svelte";
  import ToggleSidebarIcon from "./ToggleSidebarIcon.svelte";
  import { getContext } from "svelte";
  import SidebarChannelList from "./SidebarChannelList.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-svelte";
  import {
    createCategory,
    createChannel,
    createThread,
    isSpaceAdmin,
    spacePages,
  } from "$lib/jazz/utils";
  import { Category, RoomyAccount, Space } from "$lib/jazz/schema";
  import { co } from "jazz-tools";
  import SpaceSidebar from "./ui/SpaceSidebar.svelte";

  let space = $derived(
    page.params?.space ? new CoState(Space, page.params.space, {
      resolve: {
        channels: {
          $each: {
            subThreads: {
              $each: {
                timeline: {
                  perAccount: true,
                },
              },
              $onError: null,
            },
          },
          $onError: null,
        },
        categories: {
          $each: {
            channels: {
              $each: {
                subThreads: {
                  $each: {
                    timeline: {
                      perAccount: true,
                    },
                  },
                  $onError: null,
                },
              },
              $onError: null,
            },
          },
          $onError: null,
        },
      },
    }) : null
  );
  
  let links = $derived(
    space?.current?.threads?.find((x) => x?.name === "@links")
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        roomyInbox: {
          $each: true,
          $onError: null,
        },
        threadSubscriptions: {
          $onError: null,
        },
      },
      root: {
        lastRead: true,
      },
    },
  });

  export async function createLinkFeed() {
    if (!space?.current) return;

    try {
      const thread = createThread([], "@links");
      space.current?.threads?.push(thread);

      // Use $page store with .subscribe to get the current value
      const unsubscribe = page.subscribe(($page) => {
        if ($page?.params?.space) {
          navigate({ space: $page.params.space, thread: thread.id });
        }
      });
      // Immediately unsubscribe to avoid memory leaks
      unsubscribe();
    } catch (e) {
      console.error(e);
    }
  }

  function allThreads() {
    let threads = space?.current?.threads || [];
    // Use $page store with .get() to get the current value
    const currentSpace = $page?.params?.space || '';
    return threads
      .filter(
        (thread) =>
          thread !== null && !thread.softDeleted && thread.name !== "@links",
      )
      .map((thread) => {
        return {
          target: {
            space: currentSpace,
            thread: thread?.id,
          },
          name: thread?.name || "",
          id: thread?.id || "",
        };
      });
  }
  let threads = $derived(allThreads());

  const pages = $derived.by(() => {
    if (!space?.current) return [];
    const pages = spacePages(space.current);
    return pages
      .filter((page) => !page?.softDeleted)
      .map((p) => ({
        target: {
          space: page.params.space,
          page: p?.id,
        },
        name: p?.name || "",
        id: p?.id || "",
      }));
  });

  function getUsedCategories() {
    return (
      space?.current?.categories?.filter(
        (category) =>
          !category.softDeleted &&
          category?.channels?.filter((channel) => !channel?.softDeleted)
            ?.length,
      ) ?? []
    );
  }

  let sidebarItems = $derived.by(() => {
    if (!space?.current) return [];
    const categories = getUsedCategories().map((channel) => ({
      type: "category" as const,
      data: channel,
    }));
    const channels = space?.current?.channels || [];

    // only channels that are not in a category
    const channelsNotInCategory = channels
      .filter(
        (channel) =>
          !categories.some((category) =>
            category.data.channels?.some((c) => c?.id === channel.id),
          ),
      )
      .map((channel) => ({
        type: "channel" as const,
        data: channel,
      }));

    return [...channelsNotInCategory, ...categories];
  });

  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  async function createCategorySubmit() {
    if (!space?.current) return;

    const category = createCategory(newCategoryName);
    space.current?.categories?.push(category);

    showNewCategoryDialog = false;
  }

  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as
    | undefined
    | co.loaded<typeof Category>;

  async function createChannelSubmit() {
    if (!space?.current) return;

    const channel = createChannel(newChannelName);

    space.current?.channels?.push(channel);

    if (newChannelCategory) {
      newChannelCategory.channels?.push(channel);
    }

    newChannelCategory = undefined;
    newChannelName = "";
    showNewChannelDialog = false;
  }

  let isSpacesVisible: ReturnType<typeof Toggle> =
    getContext("isSpacesVisible");
</script>

 <SpaceSidebar>
  <!-- Header -->
  <div
    class="w-full pt-4 pb-1 px-2 h-fit grid grid-cols-[auto_1fr_auto] justify-center items-center"
  >
    <ToggleSidebarIcon class="pr-2" open={isSpacesVisible} />
    <h1 class="text-sm font-bold text-base-content truncate">
      {space?.current?.name && space?.current?.name !== "Unnamed"
        ? space.current?.name
        : ""}
    </h1>

    {#if isSpaceAdmin(space.current)}
      <SpaceSettingsDialog />
    {/if}
  </div>

  {#if isSpaceAdmin(space.current)}
    <menu
      class="dz-menu p-0 w-full justify-between px-2 dz-join dz-join-vertical"
    >
      <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Channel"
            class="dz-btn w-full justify-start dz-join-item text-base-content"
          >
            <Icon icon="basil:comment-plus-solid" class="size-6" />
            Create Channel
          </Button.Root>
        {/snippet}

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
              placeholder="General"
              type="text"
              required
            />
          </label>
          <label class="dz-select w-full">
            <span class="dz-label">Category</span>
            <select bind:value={newChannelCategory}>
              <option value={undefined}>None</option>
              {#each space.current?.categories?.filter((category) => !category.softDeleted) ?? [] as category}
                <option value={category}>{category.name}</option>
              {/each}
            </select>
          </label>
          <Button.Root class="dz-btn dz-btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Channel
          </Button.Root>
        </form>
      </Dialog>

      <Dialog title="Create Category" bind:isDialogOpen={showNewCategoryDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            class="dz-btn w-full justify-start dz-join-item text-base-content"
            title="Create Category"
          >
            <Icon icon="basil:folder-plus-solid" class="size-6" />
            Create Category
          </Button.Root>
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

  <div class="py-2 w-full max-h-full overflow-y-auto overflow-x-clip mx-1">
    <SidebarChannelList
      {sidebarItems}
      space={space.current}
      me={me.current}
    />
  </div>
</SpaceSidebar>
