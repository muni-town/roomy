<script lang="ts">
  import RoomEditForm from "@roomy/design/components/modals/RoomEditForm.svelte";
  import { deleteRoom, updateRoom } from "$lib/mutations/room";
  import { createQuery } from "@tanstack/svelte-query";
  import { transport, cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";

  const { agentQuery } = transport;
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
        ? agentQuery(px(), "space.roomy.room.getMetadata", { roomId })
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

  async function onSave() {
    if (!id) return;
    if (!name) return;

    if ("room" in id) {
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
  />
{/if}
