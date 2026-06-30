<script lang="ts" module>
  export type DeletedRoom = { id: string; name?: string | null };
  export type RestoreFetchState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; data: DeletedRoom[] };
</script>

<script lang="ts">
  import { Modal } from "@foxui/core";
  import Button from "../ui/button/Button.svelte";
  import { IconArrowUturnLeft } from "../../icons/index";
  import ErrorMessage from "../helper/ErrorMessage.svelte";

  let {
    open = $bindable(false),
    fetchState,
    onRestore,
  }: {
    open: boolean;
    fetchState: RestoreFetchState;
    onRestore: (roomId: string) => void;
  } = $props();
</script>

<Modal bind:open>
  <div class="max-h-[80vh] overflow-y-auto">
    <div class="flex flex-col gap-4">
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        Restore archived channels
      </h3>
      <p class="text-sm text-base-500 dark:text-base-400">
        Restore previously archived channels to make them visible again.
      </p>

      {#if fetchState.status === "loading"}
        <div class="flex flex-col gap-2 py-2">
          {#each [1, 2, 3] as _}
            <div class="h-8 bg-base-200 rounded animate-pulse"></div>
          {/each}
        </div>
      {:else if fetchState.status === "error"}
        <ErrorMessage message={fetchState.message} class="py-4 justify-center text-center" />
      {:else if fetchState.status === "success" && fetchState.data.length === 0}
        <p class="text-sm text-base-400 dark:text-base-500 py-4 text-center">
          No archived channels to restore.
        </p>
      {:else if fetchState.status === "success"}
        <ul class="flex flex-col gap-2">
          {#each fetchState.data as room (room.id)}
            <li class="flex items-center justify-between gap-2 py-1">
              <span
                class="text-sm truncate text-base-800 dark:text-base-200"
                >{room.name ?? "Unnamed channel"}</span
              >
              <Button
                variant="ghost"
                size="sm"
                onclick={() => onRestore(room.id)}
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
        <Button variant="primary" onclick={() => (open = false)}>Done</Button>
      </div>
    </div>
  </div>
</Modal>
