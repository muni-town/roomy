<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button } from "@fuxui/base";
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
    createFeedsChannel,
    createLinksChannel,
    createThread,
    isSpaceAdmin,
    spacePages,
  } from "$lib/jazz/utils";
  import {
    ATPROTO_FEED_CONFIG,
    ATPROTO_FEEDS,
    addFeedToList,
  } from "$lib/utils/atproToFeeds";
  import { Category, RoomyAccount, Space } from "$lib/jazz/schema";
  import { co } from "jazz-tools";

  let space = $derived(
    page.params?.space
      ? new CoState(Space, page.params.space, {
          resolve: {
            channels: {
              $each: true,
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
              $onError: null,
            },
          },
        })
      : null,
  );

  let links = $derived(
    space?.current?.threads?.find((x) => x?.name === "@links"),
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

  let userCreateChannelForm = $state(false);
  let userCreateCategoryForm = $state(false);
  let searchInput = $state("");

  // User admin status check
  let userIsAdmin = $derived(isSpaceAdmin(me.current, space?.current));

  let admin = $derived(space?.current?.admin);

  export async function createLinkFeed() {
    if (!space?.current) return;

    try {
      const thread = createThread([], "@links");
      space.current?.threads?.push(thread);

      // Use page rune directly
      if (page?.params?.space) {
        navigate({ space: page.params.space, thread: thread.id });
      }
    } catch (e) {
      console.error(e);
    }
  }

  function allThreads() {
    let threads = space?.current?.threads || [];
    // Use page rune directly
    const currentSpace = page?.params?.space || "";
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
  let newChannelType = $state("chat") as "chat" | "feeds" | "links";
  let newChannelCategory = $state(undefined) as
    | undefined
    | co.loaded<typeof Category>;
  let selectedFeeds = $state<string[]>([]); // Start with no feeds selected
  let customFeedInput = $state(""); // For both URLs and URIs

  async function createChannelSubmit(e: Event) {
    e.preventDefault();
    if (!space?.current) return;

    const channel =
      newChannelType === "feeds"
        ? createFeedsChannel(newChannelName, selectedFeeds)
        : newChannelType === "links"
          ? createLinksChannel(newChannelName)
          : createChannel(newChannelName, newChannelType);

    space.current?.channels?.push(channel);

    if (newChannelCategory) {
      newChannelCategory.channels?.push(channel);
    }

    newChannelCategory = undefined;
    newChannelName = "";
    newChannelType = "chat";
    selectedFeeds = []; // Reset to no feeds
    customFeedInput = "";
    showNewChannelDialog = false;
  }

  let isSpacesVisible: ReturnType<typeof Toggle> =
    getContext("isSpacesVisible");

  function toggleFeed(feedUri: string) {
    if (selectedFeeds.includes(feedUri)) {
      selectedFeeds = selectedFeeds.filter((uri) => uri !== feedUri);
    } else {
      selectedFeeds = [...selectedFeeds, feedUri];
    }
  }

  function addCustomFeed() {
    selectedFeeds = addFeedToList(
      customFeedInput,
      selectedFeeds,
      (uri) => {
        console.log(`Added feed: ${uri}`);
        customFeedInput = ""; // Clear the input on success
      },
      (error) => {
        alert(error);
      },
    );
  }

  function removeFeed(feedUri: string) {
    selectedFeeds = selectedFeeds.filter((uri) => uri !== feedUri);
  }
</script>

<!-- Header -->
<div class="w-full pt-4 pb-1 px-2 h-fit flex mb-4 justify-between items-center">
  <h1 class="text-sm font-bold text-base-900 dark:text-base-100 truncate flex-grow">
    {space?.current?.name && space?.current?.name !== "Unnamed"
      ? space.current?.name
      : ""}
  </h1>
  <div class="flex items-center gap-1">
    {#if userIsAdmin}
      <SpaceSettingsDialog />
    {/if}
  </div>
</div>

<!-- Space description -->
{#if space?.current?.description}
  <p class="text-xs text-base-content/70 line-clamp-2">
    {space.current.description}
  </p>
{/if}

{#if isSpaceAdmin(space?.current)}
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
            <div class="space-y-3">
              <h3 class="text-sm font-semibold">Select Feeds</h3>

              <!-- Available feeds -->
              <div class="space-y-2">
                {#each Object.entries(ATPROTO_FEED_CONFIG) as [uri, config]}
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedFeeds.includes(uri)}
                      onchange={() => toggleFeed(uri)}
                      class="checkbox checkbox-sm"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium">{config.name}</div>
                      <div class="text-xs text-base-content/60 truncate">
                        {config.url}
                      </div>
                    </div>
                  </label>
                {/each}
              </div>

              <!-- Custom feeds that aren't in the default list -->
              {#each selectedFeeds.filter((uri) => !ATPROTO_FEEDS.includes(uri)) as customUri}
                <div class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked
                    disabled
                    class="checkbox checkbox-sm"
                  />
                  <span class="text-sm flex-1 truncate">{customUri}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => removeFeed(customUri)}
                    class="text-error hover:bg-error/10"
                  >
                    <Icon icon="tabler:x" class="size-3" />
                  </Button>
                </div>
              {/each}

              <!-- Add custom feed from URL or URI -->
              <div class="space-y-2">
                <h4 class="text-sm font-medium">Add Custom Feed</h4>
                <div class="flex gap-2">
                  <input
                    type="text"
                    bind:value={customFeedInput}
                    placeholder="https://bsky.app/profile/did:plc:example/feed/feedname or at://..."
                    class="dz-input flex-1 text-xs"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onclick={addCustomFeed}
                    disabled={!customFeedInput}
                  >
                    Add
                  </Button>
                </div>
                <p class="text-xs text-base-content/60">
                  Accepts both Bluesky URLs and AT:// URIs
                </p>
              </div>

              <div class="text-xs text-base-content/60">
                Selected {selectedFeeds.length} feed{selectedFeeds.length !== 1
                  ? "s"
                  : ""}
              </div>
            </div>
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
</div>
