<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, Input } from "@fuxui/base";
  import {
    createPage,
    createThread,
    Group,
    IDList,
    Space,
  } from "@roomy-chat/sdk";
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

  <form
    class="px-4 flex flex-col gap-8 py-8 max-w-4xl mx-auto w-full"
    onsubmit={createObject}
  >
    <div>
      <h1 class="text-2xl font-bold mb-2">Create new object</h1>
      <p class="text-sm text-base-500">Create a new thread, group, or page.</p>
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

    <div class="mt-4">
      <Button type="submit">Create object</Button>
    </div>
  </form>
</MainLayout>
