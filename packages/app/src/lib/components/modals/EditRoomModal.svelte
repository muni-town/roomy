<script lang="ts">
  import RoomEditForm from "@roomy/design/components/modals/RoomEditForm.svelte";
  import { deleteRoom, renameRoom } from "$lib/mutations/room";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { newUlid, type Ulid, Ulid as UlidNS } from "@roomy-space/sdk";
  import ChannelPermissions from "$lib/components/ui/ChannelPermissions.svelte";
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
  let rolePermissions = $state<Record<string, "none" | "read" | "readwrite">>(
    {},
  );
  let defaultAccess = $state<"readwrite" | "read" | "none">("readwrite");

  const roomQuery = new LiveQuery<{
    name: string;
    kind: "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";
    defaultAccess: "none" | "read" | "readwrite";
  }>(
    () => sql`
    select json_object(
      'name', name,
      'kind', label,
      'defaultAccess', default_access
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
  let name = $state("");

  $effect(() => {
    name =
      room?.name ??
      (id && "categoryName" in id ? id.categoryName : "") ??
      "";
  });

  let kind = $derived.by(() => {
    if (!room) return "Category";
    switch (room.kind) {
      case "space.roomy.channel":
        return "Channel";
      default:
        throw new Error("Room had no kind");
    }
  });

  async function onSave() {
    if (!app.joinedSpace || !id)
      throw new Error("Could not find current room ID");
    if (!name) return;

    if ("room" in id) {
      if (kind === "Channel") {
        const events = [];

        if (room?.defaultAccess !== defaultAccess) {
          events.push({
            id: newUlid(),
            $type: "space.roomy.room.updateRoom.v0" as const,
            roomId: id.room,
            defaultAccess: defaultAccess as "readwrite" | "read" | "none",
          });
        }

        const allRoles = await peer.getRoles(app.joinedSpace.id);
        const permissionEvents = allRoles.flatMap((role) => {
          const existing = role.rooms.find((r) => r.roomId === id.room);
          const desired =
            accessMode === "roles"
              ? (rolePermissions[role.id] ?? "none")
              : "none";
          const existingPerm = existing?.permission ?? "none";
          if (desired === existingPerm) return [];
          return [
            {
              id: newUlid(),
              $type: "space.roomy.role.setRoleRoomPermission.v0" as const,
              roleId: UlidNS.assert(role.id),
              roomId: id.room,
              permission:
                desired === "none" ? null : (desired as "read" | "readwrite"),
            },
          ];
        });
        events.push(...permissionEvents);

        if (events.length > 0) {
          await peer.sendEventBatch(app.joinedSpace.id, events);
        }
      }

      await renameRoom({
        spaceId: app.joinedSpace.id,
        roomId: id.room,
        newName: name,
      });
    } else if ("categoryId" in id) {
      renameCategory(id.categoryId, name);
    }
    open = false;
  }

  async function onDelete() {
    if (!app.joinedSpace) throw new Error("No space found");
    if (!id || !("room" in id)) return;
    await deleteRoom({
      spaceId: app.joinedSpace.id,
      roomId: id.room,
    });
    open = false;
  }

  let canDelete = $derived(
    !!flags.roomDeletion && !!id && "room" in id,
  );
</script>

{#if id && (("room" in id && room) || "categoryId" in id)}
  <RoomEditForm
    bind:open
    {kind}
    bind:name
    {canDelete}
    {onSave}
    {onDelete}
  >
    {#snippet permissions()}
      {#if kind === "Channel" && app.joinedSpace}
        <ChannelPermissions
          spaceId={app.joinedSpace.id}
          roomId={id && "room" in id ? id.room : undefined}
          bind:accessMode
          bind:rolePermissions
          bind:defaultAccess
        />
      {/if}
    {/snippet}
  </RoomEditForm>
{/if}
