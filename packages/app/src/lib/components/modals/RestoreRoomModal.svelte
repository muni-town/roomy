<script lang="ts">
  import { restoreRoom } from "$lib/mutations/room";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { Modal } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { IconArrowUturnLeft } from "@roomy/design/icons";
  import { peer } from "$lib/workers";
  import { type AsyncStateWithIdle, type RoomMetadata } from "@roomy/sdk";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let fetchState = $state<AsyncStateWithIdle<RoomMetadata[]>>({
    status: "idle",
  });

  const deletedRooms = $derived(
    fetchState.status === "success"
      ? fetchState.data.filter((r) => r.deleted)
      : [],
  );

  $effect(() => {
    if (!open) return;
    const spaceId = app.joinedSpace?.id;
    if (!spaceId) return;

    fetchState = { status: "loading" };
    peer
      .fetchRooms(spaceId, "space.roomy.channel")
      .then((rooms) => {
        fetchState = { status: "success", data: rooms };
      })
      .catch((e) => {
        fetchState = {
          status: "error",
          message: e instanceof Error ? e.message : "Failed to load rooms",
        };
      });
  });

  async function restore(roomId: string) {
    if (!app.joinedSpace) return;
    await restoreRoom({ spaceId: app.joinedSpace.id, roomId: roomId as any });
  }
</script>

<Modal bind:open>
  <div class="max-h-[80vh] overflow-y-auto">
    <div class="flex flex-col gap-4">
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        Restore deleted channels
      </h3>
      <p class="text-sm text-base-500 dark:text-base-400">
        Restore previously deleted channels to make them visible again.
      </p>

      {#if fetchState.status === "loading"}
        <div class="flex flex-col gap-2 py-2">
          {#each [1, 2, 3] as _}
            <div class="h-8 bg-base-200 rounded animate-pulse"></div>
          {/each}
        </div>
      {:else if fetchState.status === "error"}
        <p class="text-sm text-red-500 py-4 text-center">
          {fetchState.message}
        </p>
      {:else if deletedRooms.length === 0}
        <p class="text-sm text-base-400 dark:text-base-500 py-4 text-center">
          No deleted channels to restore.
        </p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each deletedRooms as room (room.id)}
            <li class="flex items-center justify-between gap-2 py-1">
              <span class="text-sm truncate">{room.name ?? "Unnamed channel"}</span>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => restore(room.id)}
                class="shrink-0"
              >
                <IconArrowUturnLeft class="size-4" />
                Restore
              </Button>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="flex justify-end">
        <Button variant="ghost" onclick={() => (open = false)}>Close</Button>
      </div>
    </div>
  </div>
</Modal>
