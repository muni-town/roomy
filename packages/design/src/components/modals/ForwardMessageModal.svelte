<script lang="ts">
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconHashtag, IconLoading } from "../../icons/index";
  import ErrorMessage from "../helper/ErrorMessage.svelte";

  export interface ForwardTarget {
    id: string;
    name?: string;
  }

  export type ForwardFetchState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; data: ForwardTarget[] };

  let {
    open = $bindable(false),
    fetchState,
    onForward,
  }: {
    open: boolean;
    fetchState: ForwardFetchState;
    onForward: (roomId: string) => void | Promise<void>;
  } = $props();

  let query = $state("");
  let forwarding = $state(false);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      query = "";
      forwarding = false;
      errorMessage = null;
    }
  });

  const results = $derived.by<ForwardTarget[]>(() => {
    if (fetchState.status !== "success") return [];
    const q = query.trim().toLowerCase();
    if (!q) return fetchState.data;
    return fetchState.data.filter(
      (t) => t.name?.toLowerCase().includes(q) ?? false,
    );
  });

  async function handleForward(target: ForwardTarget) {
    if (forwarding) return;
    forwarding = true;
    errorMessage = null;
    try {
      await onForward(target.id);
      open = false;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Failed to forward message";
      forwarding = false;
    }
  }
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4">
    <div>
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        Forward message
      </h3>
      <p class="text-sm text-base-500 dark:text-base-400">
        Choose a room to forward this message to.
      </p>
    </div>

    <Input
      bind:value={query}
      placeholder="Search rooms…"
      aria-label="Search rooms"
    />

    {#if errorMessage}
      <ErrorMessage message={errorMessage} />
    {/if}

    {#if fetchState.status === "loading"}
      <div class="flex items-center justify-center gap-2 py-6 text-base-400">
        <IconLoading class="size-4 animate-spin" />
        <span class="text-sm">Loading rooms…</span>
      </div>
    {:else if fetchState.status === "error"}
      <ErrorMessage message={fetchState.message} class="py-4 justify-center text-center" />
    {:else if fetchState.status === "success"}
      {#if results.length === 0}
        <p class="text-sm text-base-400 dark:text-base-500 py-4 text-center">
          No matching rooms.
        </p>
      {:else}
        <ul class="flex flex-col gap-1 max-h-[40vh] overflow-y-auto">
          {#each results as target (target.id)}
            <li>
              <Button
                variant="ghost"
                class="w-full justify-start gap-2 py-2 px-2 h-auto font-normal"
                onclick={() => handleForward(target)}
                disabled={forwarding}
              >
                <IconHashtag class="size-4 shrink-0 text-base-400" />
                <span class="truncate text-sm text-base-800 dark:text-base-200">
                  {target.name ?? "Unnamed room"}
                </span>
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <div class="flex justify-end">
      <Button variant="primary" onclick={() => (open = false)}>Cancel</Button>
    </div>
  </div>
</Modal>
