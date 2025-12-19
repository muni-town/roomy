<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { current } from "$lib/queries";
  import { navigate } from "$lib/utils.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Button, Input, ScrollArea, Select } from "@fuxui/base";
  import { monotonicFactory } from "ulidx";

  const types = ["Channel", "Category"] as const;
  let type = $state("Channel") as (typeof types)[number];
  let name = $state("");

  const spaceId = current.joinedSpace?.id;

  let selectedCategory = $state("");

  let categoriesQuery = new LiveQuery<{ name: string; id: string }>(
    () => sql`
      select i.name, id(e.id) as id
      from entities e
        inner join comp_room r on e.id = r.entity
        inner join comp_info i on e.id = i.entity
      where
        e.stream_id = ${spaceId && id(spaceId)}
          and
        r.label = 'category' 
    `,
  );
  const categories = $derived(categoriesQuery.result || []);

  async function createRoom() {
    if (!spaceId) return;

    const ulid = monotonicFactory();

    // Create a new room
    const roomId = newUlid();
    await backend.sendEvent(spaceId, {
      ulid: roomId,
      parent:
        type != "Category" && selectedCategory ? selectedCategory : undefined,
      variant: {
        kind: "space.roomy.room.createRoom.v0",
        data: undefined,
      },
    });

    // Set the room info
    await backend.sendEvent(spaceId, {
      ulid: newUlid(),
      parent: roomId,
      variant: {
        kind: "space.roomy.info.v0",
        data: {
          name: {
            set: name,
          },
          avatar: { ignore: undefined },
          description: { ignore: undefined },
        },
      },
    });

    if (type == "Channel") {
      // Mark the room as a channel
      await backend.sendEvent(spaceId, {
        ulid: newUlid(),
        parent: roomId,
        variant: {
          kind: "space.roomy.room.kind.v0",
          data: {
            kind: "space.roomy.channel.v0",
            data: undefined,
          },
        },
      });

      navigate({ space: spaceId, object: roomId });
    } else if (type == "Category") {
      // Mark the room as a category
      await backend.sendEvent(spaceId, {
        ulid: newUlid(),
        parent: roomId,
        variant: {
          kind: "space.roomy.room.kind.v0",
          data: {
            kind: "space.roomy.category.v0",
            data: undefined,
          },
        },
      });

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

      {#if type != "Category"}
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
              items={[
                { value: "", label: "None" },
                ...categories.map((x) => ({ value: x.id, label: x.name })),
              ]}
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
