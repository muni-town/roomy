<script lang="ts">
  import { deleteRoom, renameRoom } from "$lib/mutations/room";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Modal } from "@foxui/core";
  import Input from "$lib/components/ui/input/Input.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { newUlid, type Ulid, Ulid as UlidNS } from "@roomy-space/sdk";
  import ChannelPermissions from "$lib/components/ui/ChannelPermissions.svelte";
  // import FeedConfiguration from "../content/bluesky-feed/FeedConfiguration.svelte";
  import { IconSave, IconTrash } from "@roomy/design/icons";
  import { flags } from "$lib/config";
  import { peer } from "$lib/workers";

  let {
    open = $bindable(false),
    id,
    renameCategory,
  }: {
    open: boolean;
    id: { room: Ulid } | { categoryId: Ulid; categoryName: string } | null;
    renameCategory: (id: Ulid, newName: string) => void;
  } = $props();

  let accessMode = $state<"open" | "roles">("open");
  let rolePermissions = $state<Record<string, "none" | "read" | "readwrite">>({});

  async function save() {
    if (!app.joinedSpace || !id)
      throw new Error("Could not find current room ID");
    if (!name) return;

    if ("room" in id) {
      await renameRoom({
        spaceId: app.joinedSpace.id,
        roomId: id.room,
        newName: name,
      });

      if (kind === "Channel") {
        const allRoles = await peer.getRoles(app.joinedSpace.id);
        const permissionEvents = allRoles.flatMap((role) => {
          const existing = role.rooms.find((r) => r.roomId === id.room);
          const desired = accessMode === "roles" ? (rolePermissions[role.id] ?? "none") : "none";
          const existingPerm = existing?.permission ?? "none";
          if (desired === existingPerm) return [];
          return [{
            id: newUlid(),
            $type: "space.roomy.role.setRoleRoomPermission.v0" as const,
            roleId: UlidNS.assert(role.id),
            roomId: id.room,
            permission: desired === "none" ? null : desired as "read" | "readwrite",
          }];
        });
        if (permissionEvents.length > 0) {
          await peer.sendEventBatch(app.joinedSpace.id, permissionEvents);
        }
      }
    } else if ("categoryId" in id) {
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
    {
      description: "name and kind for room",
      origin: "EditRoomModal.svelte",
    },
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

        {#if kind === "Channel" && app.joinedSpace}
          <div class="border-t border-base-200 dark:border-base-700 pt-4">
            <ChannelPermissions
              spaceId={app.joinedSpace.id}
              roomId={id && "room" in id ? id.room : undefined}
              bind:accessMode
              bind:rolePermissions
            />
          </div>
        {/if}

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

        {#if flags.roomDeletion && id && "room" in id}
          <h3
            class="text-base font-semibold text-base-900 dark:text-base-100 mt-8"
          >
            Danger zone
          </h3>
          <div class="flex justify-start">
            <Button
              onclick={async () => {
                if (!app.joinedSpace) throw new Error("No space found");
                await deleteRoom({
                  spaceId: app.joinedSpace.id,
                  roomId: id.room,
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
        {/if}
      </form>
    </div>
  </Modal>
{/if}
