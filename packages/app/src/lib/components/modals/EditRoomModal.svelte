<script lang="ts">
  import { deleteRoom, renameRoom } from "$lib/mutations/room";
  import { current } from "$lib/queries";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Modal, Input, Button } from "@fuxui/base";
  // import FeedConfiguration from "../content/bluesky-feed/FeedConfiguration.svelte";
  import IconLucideSave from "~icons/lucide/save";
  import IconLucideTrash from "~icons/lucide/trash";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  async function save() {
    if (!current.joinedSpace || !current.roomId)
      throw new Error("Could not find current room ID");
    if (!name) return;
    console.log("Saving", name);
    await renameRoom({
      spaceId: current.joinedSpace.id,
      roomId: current.roomId,
      newName: name,
    });
    open = false;
  }

  const roomQuery = new LiveQuery<{
    name: string;
  }>(
    () => sql`
    select json_object(
      'name', name
    ) as json
    from comp_info
    where entity = ${current.roomId}
  `,
    (row) => JSON.parse(row.json),
  );
  const room = $derived(roomQuery.result?.[0]);
  let name = $derived(room?.name);
</script>

{#if !room}
  <div>Loading...</div>
{:else}
  <Modal bind:open>
    <div class="max-h-[80vh] overflow-y-auto">
      <form id="createSpace" class="flex flex-col gap-4" onsubmit={save}>
        <h3
          id="dialog-title"
          class="text-base font-semibold text-base-900 dark:text-base-100"
        >
          Edit room
        </h3>
        <div class="mt-2">
          <p class="text-sm text-base-500 dark:text-base-400">
            Change the name of the room
          </p>
        </div>
        <Input bind:value={name} placeholder="Name" type="text" required />
        <div class="flex justify-start">
          <Button type="submit" disabled={!name} class="justify-start">
            <IconLucideSave class="size-4" />
            Save
          </Button>
        </div>

        <!-- 
      {#if entity?.components?.feedConfig}
        <div class="mt-8 pt-8 border-t border-base-300 dark:border-base-700">
          <FeedConfiguration objectId={entity.id} />
        </div>
      {/if} -->

        <h3
          class="text-base font-semibold text-base-900 dark:text-base-100 mt-8"
        >
          Danger zone
        </h3>
        <div class="mt-1">
          <p class="text-sm text-base-500 dark:text-base-400">
            This will also delete all children of this room and cannot be undone
          </p>
        </div>
        <div class="flex justify-start">
          <Button
            onclick={async () => {
              if (!current.joinedSpace || !current.roomId)
                throw new Error("Could not find current room ID");
              await deleteRoom({
                spaceId: current.joinedSpace.id,
                roomId: current.roomId,
              });
            }}
            class="justify-start"
            variant="red"
          >
            <IconLucideTrash class="size-4" />
            Delete room
          </Button>
        </div>
      </form>
    </div>
  </Modal>
{/if}
