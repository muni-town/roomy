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
  import { queryClient } from "$lib/client";
  import ChannelPermissions from "$lib/components/ui/ChannelPermissions.svelte";
  import { createRolesQuery } from "$lib/queries/roles";
  import { createFederationGrantsQuery } from "$lib/queries/federation";
  import { sendEvents } from "$lib/mutations/send-events";

  const { queryKey } = cache;

  let {
    open = $bindable(false),
    spaceId,
    id,
    federated,
    renameCategory,
    deleteCategory,
  }: {
    open: boolean;
    spaceId: string;
    id: { room: string } | { categoryId: string; categoryName: string } | null;
    /** Set when the edited room is a federated channel: its origin space and
     * origin grant ceiling. Disables rename/archive and switches the
     * permissions editor to receiver grants. */
    federated?: {
      originSpaceId: string;
      originSpaceName?: string;
      permission: "read" | "readwrite";
    };
    renameCategory: (id: string, newName: string) => void;
    deleteCategory: (id: string) => void;
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
    if (federated) return "Federated Channel";
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
  // Current receiver grants for federated channels into this space — used to
  // diff receiver-grant changes in the federated edit mode below.
  const grantsQuery = createFederationGrantsQuery(() => spaceId, {
    enabled: () => !!federated,
  });

  async function onSave() {
    if (!id) return;
    if (!name) return;

    if ("room" in id && federated) {
      // Federated (remote) channel: the only editable settings are receiver
      // grants for this space's roles. Renames and native permission rows
      // belong to the origin space and are skipped — updateRoom on B's
      // stream would 403 (not an A admin) and role_rooms writes are inert.
      const allRoles = rolesQuery.data?.roles as
        | Array<{ id: string }>
        | undefined;
      const existingGrants = grantsQuery.data?.receiverGrants ?? [];
      const events: Array<Record<string, unknown>> = [];
      for (const role of allRoles ?? []) {
        const desired = (rolePermissions[role.id] ?? "none") as
          | "none"
          | "read"
          | "readwrite";
        const current =
          existingGrants.find(
            (g) =>
              g.originSpaceId === federated.originSpaceId &&
              g.roomId === id.room &&
              g.grantee === role.id &&
              g.kind === "role",
          )?.permission ?? "none";
        if (desired === current) continue;
        events.push({
          id: newUlid(),
          $type: "space.roomy.federation.setReceiverPermission.v0",
          originSpaceId: federated.originSpaceId,
          roomId: id.room,
          grantee: role.id,
          kind: "role",
          permission: desired === "none" ? null : desired,
        });
      }
      if (events.length > 0) {
        await sendEvents(spaceId, events);
        await queryClient.invalidateQueries({
          queryKey: ["space.roomy.federation.getGrants"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["space.roomy.space.getMetadata"],
        });
      }
      open = false;
      return;
    }

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
    if (!id) return;
    if ("room" in id) {
      await deleteRoom(spaceId, id.room);
    } else if ("categoryId" in id) {
      deleteCategory(id.categoryId);
    }
    open = false;
  }

  let canDelete = $derived(!!id && !federated);
  let isCategory = $derived(!!id && "categoryId" in id);
</script>

{#if id}
  <RoomEditForm
    bind:open
    {kind}
    bind:name
    nameReadonly={!!federated}
    {canDelete}
    {onSave}
    {onDelete}
    deleteLabel={isCategory ? "Delete Category" : "Archive Channel"}
    deleteIcon={isCategory ? "trash" : "archive"}
    deleteConfirmTitle={isCategory ? "Deleting Category" : undefined}
    deleteConfirmButton={isCategory ? "Yes, Delete" : undefined}
  >
    {#snippet deleteConfirmText()}
      {#if isCategory}
        Are you sure you want to delete the category <b>{name}</b>? Channels
        in this category will move to the uncategorized section.
      {:else}
        Are you sure you want to archive <b>{name}</b>? Archived channels
        aren't visible to non-admins. You can find and restore archived
        channels when editing the sidebar.
      {/if}
    {/snippet}
    {#snippet permissions()}
      {#if kind === "Channel" || federated}
        <ChannelPermissions
          {spaceId}
          roomId={id && "room" in id ? id.room : undefined}
          {federated}
          bind:accessMode
          bind:rolePermissions
          bind:defaultAccess
        />
      {/if}
    {/snippet}
  </RoomEditForm>
{/if}
