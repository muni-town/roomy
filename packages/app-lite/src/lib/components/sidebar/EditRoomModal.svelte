<script lang="ts">
  import RoomEditForm from "@roomy/design/components/modals/RoomEditForm.svelte";
  import {
    deleteRoom,
    updateRoom,
    type Permission,
  } from "$lib/mutations/room";
  import { createQuery } from "@tanstack/svelte-query";
  import { cache, newUlid } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import ChannelPermissions from "$lib/components/ui/ChannelPermissions.svelte";
  import { createRolesQuery } from "$lib/queries/roles";
  import { sendEvents } from "$lib/mutations/send-events";

  const { queryKey } = cache;

  let {
    open = $bindable(false),
    spaceId,
    id,
    renameCategory,
  }: {
    open: boolean;
    spaceId: string;
    id: { room: string } | { categoryId: string; categoryName: string } | null;
    renameCategory: (id: string, newName: string) => void;
  } = $props();

  const isRoom = $derived(id !== null && "room" in id);
  const roomId = $derived(isRoom ? (id as { room: string }).room : null);

  const roomQuery = createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", {
      roomId: roomId,
    }),
    queryFn: () =>
      roomId
        ? px().query("space.roomy.room.getMetadata", { roomId })
        : null,
    enabled: !!roomId,
  }));

  const room = $derived(roomQuery.data);

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
        return "Channel";
    }
  });

  // Permissions state
  let accessMode = $state<"open" | "roles">("open");
  let rolePermissions = $state<Record<string, Permission>>({});
  let defaultAccess = $state<Permission>("readwrite");

  // Track the initial defaultAccess so we know if it changed
  let initialDefaultAccess = $state<Permission | null>(null);
  $effect(() => {
    if (room?.defaultAccess && initialDefaultAccess === null) {
      initialDefaultAccess = room.defaultAccess as Permission;
    }
  });

  // Fetch roles for permission diffing on save
  const rolesQuery = createRolesQuery(() => spaceId);

  async function onSave() {
    if (!id) return;
    if (!name) return;

    if ("room" in id) {
      const events: Array<Record<string, unknown>> = [];

      // Update defaultAccess if it changed
      if (
        kind === "Channel" &&
        room?.defaultAccess !== defaultAccess
      ) {
        events.push({
          id: newUlid(),
          $type: "space.roomy.room.updateRoom.v0",
          roomId: id.room,
          defaultAccess,
        });
      }

      // Send role permission changes
      if (kind === "Channel") {
        const allRoles = rolesQuery.data?.roles as
          | Array<{
              id: string;
              rooms: Array<{ roomId: string; permission: string }>;
            }>
          | undefined;
        if (allRoles) {
          const permissionEvents = allRoles.flatMap((role: { id: string; rooms: Array<{ roomId: string; permission: string }> }) => {
            const existing = role.rooms.find(
              (r: { roomId: string; permission: string }) => r.roomId === id.room,
            );
            const desired =
              accessMode === "roles"
                ? (rolePermissions[role.id] ?? "none")
                : "none";
            const existingPerm = existing?.permission ?? "none";
            if (desired === existingPerm) return [];
            return [
              {
                id: newUlid(),
                $type: "space.roomy.role.setRoleRoomPermission.v0",
                roleId: role.id,
                roomId: id.room,
                permission:
                  desired === "none"
                    ? null
                    : (desired as "read" | "readwrite"),
              },
            ];
          });
          events.push(...permissionEvents);
        }
      }

      // Send batch if there are permission/defaultAccess changes
      if (events.length > 0) {
        await sendEvents(spaceId, events);
      }

      // Always update name
      await updateRoom(spaceId, {
        roomId: id.room,
        name,
      });
    } else if ("categoryId" in id) {
      renameCategory(id.categoryId, name);
    }
    open = false;
  }

  async function onDelete() {
    if (!id || !("room" in id)) return;
    await deleteRoom(spaceId, id.room);
    open = false;
  }

  let canDelete = $derived(!!id && "room" in id);
</script>

{#if id}
  <RoomEditForm
    bind:open
    {kind}
    bind:name
    {canDelete}
    {onSave}
    {onDelete}
  >
    {#snippet permissions()}
      {#if kind === "Channel"}
        <ChannelPermissions
          {spaceId}
          roomId={id && "room" in id ? id.room : undefined}
          bind:accessMode
          bind:rolePermissions
          bind:defaultAccess
        />
      {/if}
    {/snippet}
  </RoomEditForm>
{/if}
