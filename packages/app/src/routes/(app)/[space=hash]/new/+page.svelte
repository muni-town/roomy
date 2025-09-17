<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, Input, ScrollArea, Select } from "@fuxui/base";
  import {
    addToFolder,
    AllFoldersComponent,
    AllPagesComponent,
    AllThreadsComponent,
    co,
    createFolder,
    createPage,
    createRoomyEntity,
    createThread,
    getSpaceGroups,
    RoomyEntity,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";

  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: true,
      },
    }),
  );

  const allFolders = $derived(
    new CoState(
      AllFoldersComponent,
      space?.current?.components?.[AllFoldersComponent.id],
    ),
  );

  const allThreads = $derived(
    new CoState(
      AllThreadsComponent,
      space?.current?.components?.[AllThreadsComponent.id],
    ),
  );

  const allPages = $derived(
    new CoState(
      AllPagesComponent,
      space?.current?.components?.[AllPagesComponent.id],
    ),
  );

  let objectType = $state("Channel");
  let objectName = $state("");

  async function addAsChild(object: co.loaded<typeof RoomyEntity>) {
    if (selectedParent === "root") {
      console.log("adding to root", space.current, object);
      addToFolder(space.current!, object);
    } else {
      const folder = allFolders.current?.find(
        (folder) => folder?.id === selectedParent,
      );

      if (folder) {
        addToFolder(folder, object);
      }
    }
  }

  async function createObject(event: Event) {
    event.preventDefault();
    console.log(objectType, objectName);

    if (!objectName.trim()) {
      return;
    }

    if (!space?.current) {
      console.error("Space not found");
      return;
    }

    const groups = await getSpaceGroups(space.current);

    if (objectType === "Channel") {
      // add thread
      const { entity: thread } = await createThread(objectName, groups);

      addAsChild(thread);

      allThreads.current?.push(thread);
      navigate({ space: space.current?.id, object: thread.id });
    } else if (objectType === "Feeds") {
      // add feed thread
      const feed = await createRoomyEntity(objectName, groups.admin);

      // Remove thread component and add feed configuration
      feed.components.feedConfig = JSON.stringify({
        feeds: [],
        threadsOnly: false,
        enabled: false,
      });

      addAsChild(feed);

      allThreads.current?.push(feed);
      navigate({ space: space.current?.id, object: feed.id });
    } else if (objectType === "Group") {
      // add group
      const { entity: group } = await createFolder(objectName, groups.admin);

      addAsChild(group);

      allFolders.current?.push(group);
    } else if (objectType === "Page") {
      // add page
      const { entity: page } = await createPage(objectName, groups.admin);

      addAsChild(page);

      allPages.current?.push(page);
      navigate({ space: space.current?.id, object: page.id });
    }
  }

  let selectedParent = $state("root");

  let folders = $derived(
    (allFolders.current ?? [])
      .map((folder) => {
        return {
          value: folder?.id,
          label: folder?.name,
        };
      })
      .filter((folder) => folder.value && folder.label) as {
      value: string;
      label: string;
    }[],
  );

  const types = ["Channel", "Feeds", "Group", "Page"];
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

  <ScrollArea>
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-3xl mx-auto w-full"
      onsubmit={createObject}
    >
      <div>
        <h1 class="text-xl font-bold mb-2">Create new object</h1>
        <p class="text-sm text-base-500">
          Create a new channel, group or page.
        </p>
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
          {#each types as type}
            <div class="flex items-center gap-x-3">
              <input
                id="{type}-type"
                name="{type}-type"
                type="radio"
                checked
                bind:group={objectType}
                value={type}
                class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
              />
              <label
                for="{type}-type"
                class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
                >{type}</label
              >
            </div>
          {/each}
        </div>
      </fieldset>

      <div>
        <label
          for="parent"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Child of</label
        >
        <div class="mt-2">
          <Select
            bind:value={selectedParent}
            type="single"
            items={[{ value: "root", label: "root" }, ...folders]}
          />
        </div>
      </div>

      <div class="mt-4">
        <Button type="submit">Create object</Button>
      </div>
    </form>
  </ScrollArea>
</MainLayout>
