<script lang="ts">
  import RestoreDialog, {
    type RestoreFetchState,
  } from "@roomy/design/components/modals/RestoreDialog.svelte";
  import { restoreRoom } from "$lib/mutations/room";
  import { getAppState } from "$lib/queries";
  import { peer } from "$lib/workers";

  const app = getAppState();

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let fetchState = $state<RestoreFetchState>({ status: "idle" });

  $effect(() => {
    if (!open) return;
    const spaceId = app.joinedSpace?.id;
    if (!spaceId) return;

    fetchState = { status: "loading" };
    peer
      .fetchRooms(spaceId, "space.roomy.channel")
      .then((rooms) => {
        fetchState = {
          status: "success",
          data: rooms.filter((r) => r.deleted),
        };
      })
      .catch((e) => {
        fetchState = {
          status: "error",
          message: e instanceof Error ? e.message : "Failed to load rooms",
        };
      });
  });

  async function onRestore(roomId: string) {
    if (!app.joinedSpace) return;
    await restoreRoom({ spaceId: app.joinedSpace.id, roomId: roomId as any });
  }
</script>

<RestoreDialog bind:open {fetchState} {onRestore} />
