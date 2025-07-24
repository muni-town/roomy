<script lang="ts">
  import { ChildrenComponent, RoomyEntity } from "@roomy-chat/sdk";
  import { Modal, Input, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { co } from "jazz-tools";
  import FeedConfiguration from "../FeedConfiguration.svelte";

  let {
    open = $bindable(false),
    entity = $bindable(null),
  }: {
    open: boolean;
    entity: co.loaded<typeof RoomyEntity> | undefined | null | null;
  } = $props();

  let entityName = $derived(entity?.name);

  async function save() {
    console.log("save", entityName, entity);
    if (!entityName || !entity) return;

    entity.name = entityName;

    open = false;
  }

  async function deleteObject() {
    if (!entity) return;

    entity.softDeleted = true;

    await deleteChildren(entity);

    open = false;
  }

  // recursively delete children
  async function deleteChildren(object: co.loaded<typeof RoomyEntity>) {
    if (!object) return;

    object.ensureLoaded({
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    });

    const childrenId = object.components?.[ChildrenComponent.id];

    if (!childrenId) return;

    const children = await ChildrenComponent.load(childrenId, {
      resolve: {
        $each: {
          components: {
            $each: true,
            $onError: null,
          },
        },
      },
    });

    for (const child of children ?? []) {
      child.softDeleted = true;

      await deleteChildren(child);
    }
  }
</script>

<Modal bind:open>
  <div class="max-h-[80vh] overflow-y-auto">
    <form id="createSpace" class="flex flex-col gap-4" onsubmit={save}>
    <h3
      id="dialog-title"
      class="text-base font-semibold text-base-900 dark:text-base-100"
    >
      Edit object
    </h3>
    <div class="mt-2">
      <p class="text-sm text-base-500 dark:text-base-400">
        Change the name of the object
      </p>
    </div>
    <Input bind:value={entityName} placeholder="Name" type="text" required />
    <div class="flex justify-start">
      <Button type="submit" disabled={!entityName} class="justify-start">
        <Icon icon="lucide:save" class="size-4" />
        Save
      </Button>
    </div>

    <!-- Feed Configuration Section -->
    {#if entity?.components?.feedConfig}
      <div class="mt-8 pt-8 border-t border-base-300 dark:border-base-700">
        <FeedConfiguration thread={entity} />
      </div>
    {/if}

    <h3 class="text-base font-semibold text-base-900 dark:text-base-100 mt-8">
      Danger zone
    </h3>
    <div class="mt-1">
      <p class="text-sm text-base-500 dark:text-base-400">
        This will also delete all children of this object and cannot be undone
      </p>
    </div>
    <div class="flex justify-start">
      <Button onclick={deleteObject} class="justify-start" variant="red">
        <Icon icon="lucide:trash" class="size-4" />
        Delete object
      </Button>
    </div>
  </form>
  </div>
</Modal>
