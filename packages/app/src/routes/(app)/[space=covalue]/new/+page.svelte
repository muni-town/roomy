<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, Input } from "@fuxui/base";
  import {
    createFolder,
    createPage,
    createThread,
    Group,
    IDList,
    Space,
  } from "@roomy-chat/sdk";
  import { ATPROTO_FEEDS, ATPROTO_FEED_CONFIG } from "$lib/utils/atproToFeeds";
  import { CoState } from "jazz-svelte";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        folders: true,
        threads: true,
        pages: true,
      },
    }),
  );

  const children = $derived(new CoState(IDList, space?.current?.rootFolder?.components?.children));
  
  let adminGroup = $derived(new CoState(Group, space?.current?.adminGroupId));

  let objectType = $state("thread");
  let objectName = $state("");
  
  // Feed aggregator configuration state
  let selectedFeeds = $state<string[]>([]); // Start with no feeds selected
  let customFeedUri = $state("");
  let feedThreadsOnly = $state(false);

  function createFeedAggregator(name: string, adminGroup: any) {
    // Create a regular thread first
    const thread = createThread(name, adminGroup);
    
    // Get all selected feeds (default + custom)
    const allFeeds = [...selectedFeeds];
    if (customFeedUri.trim()) {
      allFeeds.push(customFeedUri.trim());
    }
    
    // Configure it as a feed aggregator
    const feedConfig = {
      feeds: allFeeds,
      threadsOnly: feedThreadsOnly,
      enabled: true
    };
    
    // Store feed aggregator configuration in components
    thread.roomyObject.components.feedConfig = JSON.stringify(feedConfig);
    
    return thread;
  }
  
  function toggleFeed(feedUri: string) {
    if (selectedFeeds.includes(feedUri)) {
      selectedFeeds = selectedFeeds.filter(uri => uri !== feedUri);
    } else {
      selectedFeeds = [...selectedFeeds, feedUri];
    }
  }

  function createObject(event: Event) {
    event.preventDefault();
    console.log(objectType, objectName);

    if (!objectName.trim()) {
      return;
    }

    if (!adminGroup.current || !space?.current) {
      console.error("Admin group or space not found");
      return;
    }

    if (objectType === "thread") {
      // add thread
      const thread = createThread(objectName, adminGroup.current);

      // find first folder
      const firstFolder = space.current?.folders?.[0];

      console.log(firstFolder);

      // add to root folder
      children.current?.push(thread.roomyObject.id);
      space.current?.threads?.push(thread.roomyObject);

      navigate({ space: space.current?.id, object: thread.roomyObject.id });
    } else if (objectType === "feed") {
      // add feed aggregator
      const feedAggregator = createFeedAggregator(objectName, adminGroup.current);

      // add to root folder
      children.current?.push(feedAggregator.roomyObject.id);
      space.current?.threads?.push(feedAggregator.roomyObject);

      navigate({ space: space.current?.id, object: feedAggregator.roomyObject.id });
    } else if (objectType === "group") {
      // add group
      // const group = createFolder(objectName, adminGroup.current);
      // // add to root folder
      // space.current?.rootFolder?.childrenIds?.push(group.id);
      // space.current?.folders?.push(group);
      // navigate({ space: space.current?.id, object: group.id });
    } else if (objectType === "page") {
      // add page
      const page = createPage(objectName, adminGroup.current);

      // add to root folder
      children.current?.push(page.roomyObject.id);
      space.current?.pages?.push(page.roomyObject);

      navigate({ space: space.current?.id, object: page.roomyObject.id });
    }
  }
</script>

{#if space.current}
  <div class="h-0 w-0"></div>
{/if}

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span>New object</span>
      </h2>
    </div>
  {/snippet}

  <div class="flex-1 overflow-y-auto">
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-4xl mx-auto w-full"
      onsubmit={createObject}
    >
    <div>
      <h1 class="text-2xl font-bold mb-2">Create new object</h1>
      <p class="text-sm text-base-500">Create a new thread, feed aggregator, or page.</p>
    </div>

    <div>
      <label
        for="name"
        class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
        >Name</label
      >
      <div class="mt-2">
        <Input class="w-full" id="name" bind:value={objectName} />
      </div>
    </div>

    <fieldset>
      <legend class="text-sm/6 font-semibold text-base-900 dark:text-base-100"
        >Object type</legend
      >
      <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
        Choose the type of object you want to create.
      </p>
      <div class="mt-6 space-y-4">
        <div class="flex items-center gap-x-3">
          <input
            id="thread-type"
            name="thread-type"
            type="radio"
            checked
            bind:group={objectType}
            value="thread"
            class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
          />
          <label
            for="thread-type"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >Thread</label
          >
        </div>
        <div class="flex items-center gap-x-3">
          <input
            id="feed-type"
            name="feed-type"
            type="radio"
            bind:group={objectType}
            value="feed"
            class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
          />
          <label
            for="feed-type"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >Feed Aggregator</label
          >
        </div>
        <!-- <div class="flex items-center gap-x-3">
          <input
            id="group-type"
            name="group-type"
            type="radio"
            bind:group={objectType}
            value="group"
            class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
          />
          <label
            for="group-type"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100">Group</label
          >
        </div> -->
        <div class="flex items-center gap-x-3">
          <input
            id="page-type"
            name="page-type"
            type="radio"
            bind:group={objectType}
            value="page"
            class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
          />
          <label
            for="page-type"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >Page</label
          >
        </div>
      </div>
    </fieldset>

    <!-- Feed Aggregator Configuration (only show when feed aggregator is selected) -->
    {#if objectType === "feed"}
      <div class="space-y-6">
        <!-- Default Feeds Selection -->
        <fieldset>
          <legend class="text-sm/6 font-semibold text-base-900 dark:text-base-100">Default Feeds</legend>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Select which default AT Protocol feeds to include in your feed aggregator.
          </p>
          <div class="mt-4 space-y-3">
            {#each ATPROTO_FEEDS as feedUri}
              <div class="flex items-center gap-x-3">
                <input
                  id="feed-{feedUri}"
                  name="feed-{feedUri}"
                  type="checkbox"
                  checked={selectedFeeds.includes(feedUri)}
                  onchange={() => toggleFeed(feedUri)}
                  class="size-4 rounded border-base-300 dark:border-base-700 text-accent-600 focus:ring-accent-600 dark:focus:ring-accent-400"
                />
                <label
                  for="feed-{feedUri}"
                  class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
                >
                  {ATPROTO_FEED_CONFIG[feedUri]?.name || feedUri}
                </label>
              </div>
            {/each}
          </div>
        </fieldset>

        <!-- Custom Feed URI -->
        <div>
          <label
            for="custom-feed"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            Custom Feed URI (optional)
          </label>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Add a custom AT Protocol feed URI (at://...)
          </p>
          <div class="mt-2">
            <input
              id="custom-feed"
              type="text"
              bind:value={customFeedUri}
              placeholder="at://did:plc:example/app.bsky.feed.generator/custom-feed"
              class="block w-full rounded-md border-0 py-1.5 text-base-900 dark:text-base-100 shadow-sm ring-1 ring-inset ring-base-300 dark:ring-base-700 placeholder:text-base-400 focus:ring-2 focus:ring-inset focus:ring-accent-600 dark:focus:ring-accent-400 sm:text-sm/6 bg-white dark:bg-base-800"
            />
          </div>
        </div>

        <!-- Feed Aggregator Options -->
        <fieldset>
          <legend class="text-sm/6 font-semibold text-base-900 dark:text-base-100">Feed Aggregator Options</legend>
          <div class="mt-4">
            <div class="flex items-center gap-x-3">
              <input
                id="threads-only"
                name="threads-only"
                type="checkbox"
                bind:checked={feedThreadsOnly}
                class="size-4 rounded border-base-300 dark:border-base-700 text-accent-600 focus:ring-accent-600 dark:focus:ring-accent-400"
              />
              <label
                for="threads-only"
                class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
              >
                Threads only
              </label>
            </div>
            <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400 ml-7">
              Only show posts that have replies (thread-style conversations)
            </p>
          </div>
        </fieldset>
      </div>
    {/if}

    <div class="mt-4">
      <Button type="submit">Create object</Button>
    </div>
    </form>
  </div>
</MainLayout>
