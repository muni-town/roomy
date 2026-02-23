<script lang="ts">
  import { deleteRoom, renameRoom } from "$lib/mutations/room";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Modal } from "@foxui/core";
  import Input from "$lib/components/ui/input/Input.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import type { Ulid } from "@roomy/sdk";
  // import FeedConfiguration from "../content/bluesky-feed/FeedConfiguration.svelte";
  import { IconSave, IconTrash } from "@roomy/design/icons";

  let {
    open = $bindable(false),
    id,
    renameCategory,
  }: {
    open: boolean;
    id: { room: Ulid } | { categoryId: Ulid; categoryName: string } | null;
    renameCategory: (id: Ulid, newName: string) => void;
  } = $props();

  async function save() {
    if (!app.joinedSpace || !id)
      throw new Error("Could not find current room ID");
    if (!name) return;

    if ("room" in id) {
      console.log("Saving Room", name);
      await renameRoom({
        spaceId: app.joinedSpace.id,
        roomId: id.room,
        newName: name,
      });
    } else if ("categoryId" in id) {
      console.log("Todo: save category name");
      renameCategory(id.categoryId, name);
    }
    open = false;
  }

  const roomQuery = new LiveQuery<{
    name: string;
    kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
  }>(
    () => sql`
    select json_object(
      'name', name,
      'kind', label
    ) as json
    from comp_info ci
    left join comp_room cr on ci.entity = cr.entity
    where ci.entity = ${(id && "room" in id && id.room) ?? ""}
  `,
    (row) => JSON.parse(row.json),
  );
  const room = $derived(roomQuery.result?.[0]);
  let name = $derived(
    room?.name ?? (id && "categoryName" in id && id.categoryName) ?? "",
  );
  let kind = $derived.by(() => {
    if (!room) return "Category";
    // TODO: replace the whole rename functionality with in-place input
    // For now just support Channel and Category which will not be a room
    switch (room.kind) {
      case "space.roomy.channel":
        return "Channel";
      default:
        throw new Error("Room had no kind");
    }
  });
</script>

{#if id && (("room" in id && room) || "categoryId" in id)}
  <Modal bind:open>
    <div class="max-h-[80vh] overflow-y-auto">
      <form id="createSpace" class="flex flex-col gap-4" onsubmit={save}>
        <h3
          id="dialog-title"
          class="text-base font-semibold text-base-900 dark:text-base-100"
        >
          Edit {kind}
        </h3>
        <div class="mt-2">
          <p class="text-sm text-base-500 dark:text-base-400">
            Change the name of the {kind.toLowerCase()}
          </p>
        </div>
        <Input bind:value={name} placeholder="Name" type="text" required />
        <div class="flex justify-start">
          <Button type="submit" disabled={!name} class="justify-start">
            <IconSave class="size-4" />
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
        <div class="flex justify-start">
          <Button
            onclick={async () => {
              if (!app.joinedSpace || !app.roomId)
                throw new Error("Could not find current room ID");
              await deleteRoom({
                spaceId: app.joinedSpace.id,
                roomId: app.roomId,
              });
              open = false;
            }}
            class="justify-start"
            variant="red"
          >
            <IconTrash class="size-4" />
            Delete {kind}
          </Button>
        </div>
      </form>
    </div>
  </Modal>
{/if}
