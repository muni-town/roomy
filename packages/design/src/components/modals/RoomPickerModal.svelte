<script lang="ts">
  import type { Snippet } from "svelte";
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconHashtag, IconLoading, IconCheck } from "../../icons/index";
  import ErrorMessage from "../helper/ErrorMessage.svelte";

  export interface RoomPickerTarget {
    id: string;
    name?: string;
  }

  export type RoomPickerFetchState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; data: RoomPickerTarget[] };

  /** `forward` cross-posts the messages as new forward messages (multi-select,
   *  optional commentary); `move` relocates the originals (single-select,
   *  no commentary). */
  export type RoomPickerMode = "forward" | "move";

  let {
    open = $bindable(false),
    mode = "forward",
    fetchState,
    onSelect,
    composer,
    query = $bindable(""),
  }: {
    open: boolean;
    mode?: RoomPickerMode;
    fetchState: RoomPickerFetchState;
    /** Called with the chosen room ids. A move always passes exactly one. */
    onSelect: (roomIds: string[]) => void | Promise<void>;
    /** WYSIWYG message composer (the chat input). Renders below the room picker. */
    composer?: Snippet;
    /** Room-name search term. The host owns the query (e.g. to drive a
     *  server-side search) — this modal renders the input and filters
     *  nothing; `fetchState.data` is the full list to display. */
    query?: string;
  } = $props();

  const isMove = $derived(mode === "move");

  let selected = $state<string[]>([]);
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      query = "";
      selected = [];
      submitting = false;
      errorMessage = null;
    }
  });

  const selectedIds = $derived(new Set(selected));

  // Local filter over the host-provided list. The host may already have
  // server-filtered (room-name search); this is a pure client-side fallback
  // so the modal stays usable standalone (e.g. design docs/tests).
  const results = $derived.by<RoomPickerTarget[]>(() => {
    if (fetchState.status !== "success") return [];
    const q = query.trim().toLowerCase();
    if (!q) return fetchState.data;
    return fetchState.data.filter(
      (t) => t.name?.toLowerCase().includes(q) ?? false,
    );
  });

  function toggle(target: RoomPickerTarget) {
    if (submitting) return;
    if (isMove) {
      // A move has exactly one destination: picking a room replaces the
      // previous choice rather than adding to it.
      selected = selectedIds.has(target.id) ? [] : [target.id];
      return;
    }
    selected = selectedIds.has(target.id)
      ? selected.filter((id) => id !== target.id)
      : [...selected, target.id];
  }

  async function handleSend() {
    if (submitting || selected.length === 0) return;
    submitting = true;
    errorMessage = null;
    try {
      await onSelect(selected);
      open = false;
    } catch (e) {
      errorMessage =
        e instanceof Error
          ? e.message
          : isMove
            ? "Failed to move message"
            : "Failed to forward message";
      submitting = false;
    }
  }
</script>

<Modal bind:open>
  <!-- The modal body is a grid item of Dialog.Content, so its `min-width: auto`
       resolves to the widest child's min-content width — a long room name in
       the list would widen the whole body past the dialog and spill out.
       `min-w-0` lets the body shrink so the row's `truncate` can engage. -->
  <div class="flex flex-col gap-4 min-w-0">
    <div>
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        {isMove ? "Move message" : "Forward message"}
      </h3>
      <p class="text-sm text-base-500 dark:text-base-400">
        {isMove
          ? "Select a room, then move."
          : "Select one or more rooms, then send."}
      </p>
    </div>

    <Input
      bind:value={query}
      placeholder="Search rooms…"
      aria-label="Search rooms"
      class="w-full min-w-0"
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
            {@const isSelected = selectedIds.has(target.id)}
            <li>
              <button
                type="button"
                onclick={() => toggle(target)}
                disabled={submitting}
                aria-pressed={isSelected}
                class={
                  "w-full flex items-center gap-2 rounded-md py-2 px-2 text-start font-normal border-1 disabled:opacity-50 " +
                  (isSelected
                    ? "border-accent-500/60 bg-accent-50 dark:bg-accent-900/40"
                    : "border-transparent hover:bg-base-100 dark:hover:bg-base-400/10")
                }
              >
                <IconHashtag class="size-4 shrink-0 text-base-400" />
                <span class="truncate text-sm text-base-800 dark:text-base-200 flex-1">
                  {target.name ?? "Unnamed room"}
                </span>
                {#if isSelected}
                  <IconCheck class="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if composer && !isMove}
      <div>
        <label
          for="forward-composer"
          class="text-xs font-semibold uppercase tracking-wide text-base-500 dark:text-base-400"
        >
          Add a message (optional)
        </label>
        <div id="forward-composer" class="mt-1 rounded-md border border-neutral-400/50 dark:border-neutral-700 bg-neutral-300/50 dark:bg-neutral-900 px-2 py-1.5 focus-within:border-accent-400">
          {@render composer()}
        </div>
      </div>
    {/if}

    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button
        variant="primary"
        onclick={handleSend}
        disabled={selected.length === 0 || submitting}
      >
        {#if submitting}
          <IconLoading class="size-4 animate-spin" />
          {isMove ? "Moving…" : "Sending…"}
        {:else if isMove}
          Move
        {:else}
          Send {selected.length > 0 ? `to ${selected.length} room${selected.length > 1 ? "s" : ""}` : ""}
        {/if}
      </Button>
    </div>
  </div>
</Modal>
