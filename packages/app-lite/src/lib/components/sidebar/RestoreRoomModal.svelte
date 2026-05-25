<script lang="ts">
  import RestoreDialog, {
    type RestoreFetchState,
  } from "@roomy/design/components/modals/RestoreDialog.svelte";
  import { restoreRoom } from "$lib/mutations/room";
  import { createQuery } from "@tanstack/svelte-query";
  import { transport, cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";

  const { agentQuery } = transport;
  const { queryKey } = cache;

  let {
    open = $bindable(false),
    spaceId,
  }: {
    open: boolean;
    spaceId: string;
  } = $props();

  const deletedRoomsQuery = createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMetadata", {
      spaceId,
      includeDeleted: "true",
    }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.space.getMetadata", {
        spaceId,
        includeDeleted: "true",
      }),
    enabled: open,
  }));

  const fetchState = $derived.by((): RestoreFetchState => {
    if (!open) return { status: "idle" };
    if (deletedRoomsQuery.isPending) return { status: "loading" };
    if (deletedRoomsQuery.isError)
      return {
        status: "error",
        message:
          deletedRoomsQuery.error instanceof Error
            ? deletedRoomsQuery.error.message
            : "Failed to load rooms",
      };
    const rooms = deletedRoomsQuery.data?.deletedRooms ?? [];
    return { status: "success", data: rooms };
  });

  async function onRestore(roomId: string) {
    await restoreRoom(spaceId, roomId);
  }
</script>

<RestoreDialog bind:open {fetchState} {onRestore} />
