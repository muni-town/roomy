<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { Button, Input, ScrollArea, Select } from "@fuxui/base";

  let objectType = $state("Channel");
  let objectName = $state("");

  let selectedParent = $state("root");

  const types = ["Channel", "Feeds", "Group", "Page"];

  function createObject() {}
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  <ScrollArea>
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-3xl mx-auto w-full"
      onsubmit={createObject}
    >
      <div>
        <h1 class="text-xl font-bold mb-2">New</h1>
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
          >Type</legend
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
            items={[{ value: "root", label: "root" }]}
          />
        </div>
      </div>

      <div class="mt-4">
        <Button type="submit">Create</Button>
      </div>
    </form>
  </ScrollArea>
</MainLayout>
