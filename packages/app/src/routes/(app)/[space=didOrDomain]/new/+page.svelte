<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { categoriesQuery, current } from "$lib/queries";
  import { navigate } from "$lib/utils.svelte";
  import { peer } from "$lib/workers";
  import { Button, Input, ScrollArea, Select } from "@fuxui/base";
  import { Ulid, ulidFactory } from "@roomy/sdk";
  import { deepClone } from "@ark/util";

  const types = ["Channel", "Category"] as const;
  let type = $state("Channel") as (typeof types)[number];
  let name = $state("");

  const spaceId = current.joinedSpace?.id;

  let categories = $derived(
    categoriesQuery.result?.map((x) => ({
      id: x.id,
      name: x.name,
      children: x.children.map((x) => Ulid.assert(x.id)),
    })),
  );

  let selectedCategory = $state("");
  $effect(() => {
    selectedCategory = categories?.[0]?.name || "";
  });

  // redirect to space home if not joined
  $effect(() => {
    if (current.space.status === "invited") {
      navigate({
        space: current.space.spaceId,
      });
    }
  });

  async function createRoom() {
    if (!spaceId || !categories) return;

    const newUlid = ulidFactory();

    // Ensure all categories have ULIDs (v0 data may have null ids)
    const newCategories = deepClone(categories).map((c) => ({
      ...c,
      id: c.id ?? newUlid(),
    }));

    // Create a new room
    const id = newUlid();
    if (type == "Category") {
      newCategories.push({ id: newUlid(), name, children: [] });

      await peer.sendEvent(spaceId, {
        id,
        $type: "space.roomy.space.updateSidebar.v1",
        categories: newCategories,
      });
    } else {
      const selected = newCategories.find((x) => x.name == selectedCategory);
      if (!selected) throw new Error("Must select category");

      selected.children.push(id);

      await peer.sendEventBatch(spaceId, [
        {
          id,
          $type: "space.roomy.room.createRoom.v0",
          kind: "space.roomy.channel",
          name,
        },
        {
          id: newUlid(),
          $type: "space.roomy.space.updateSidebar.v1",
          categories: newCategories,
        },
      ]);
    }

    if (type == "Channel") {
      navigate({ space: spaceId, object: id });
    } else if (type == "Category") {
      navigate({ space: spaceId });
    }
  }
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  <ScrollArea>
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-3xl mx-auto w-full"
      onsubmit={createRoom}
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
          <Input class="w-full" id="name" bind:value={name} />
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
          {#each types as typeName}
            <div class="flex items-center gap-x-3">
              <input
                id="{typeName}-type"
                name="{typeName}-type"
                type="radio"
                checked
                bind:group={type}
                value={typeName}
                class="relative size-4 appearance-none rounded-full border border-base-300 dark:border-base-700 bg-white dark:bg-base-800 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-accent-600 dark:checked:border-accent-400 dark:checked:bg-accent-400 checked:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 disabled:border-base-300 disabled:bg-base-100 disabled:before:bg-base-400 forced-colors:appearance-auto forced-colors:before:hidden"
              />
              <label
                for="{typeName}-type"
                class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
                >{typeName}</label
              >
            </div>
          {/each}
        </div>
      </fieldset>

      {#if type != "Category" && !!categories}
        <div>
          <label
            for="parent"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >Category</label
          >
          <div class="mt-2">
            <Select
              bind:value={selectedCategory}
              type="single"
              items={categories.map((x) => ({ value: x.name, label: x.name }))}
            />
          </div>
        </div>
      {/if}

      <div class="mt-4">
        <Button type="submit">Create</Button>
      </div>
    </form>
  </ScrollArea>
</MainLayout>
