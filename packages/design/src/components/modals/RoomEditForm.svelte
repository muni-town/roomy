<script lang="ts">
  import type { Snippet } from "svelte";
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconSave, IconTrash } from "../../icons/index";

  let {
    open = $bindable(false),
    kind,
    name = $bindable(""),
    canDelete = false,
    permissions,
    onSave,
    onDelete,
  }: {
    open: boolean;
    /** "Channel" / "Category" / etc. — used in the title and description. */
    kind: string;
    name: string;
    /** When true, renders the "Delete" danger-zone button. */
    canDelete?: boolean;
    /** Optional permissions editor (e.g. ChannelPermissions component). */
    permissions?: Snippet;
    onSave: () => void | Promise<void>;
    onDelete?: () => void | Promise<void>;
  } = $props();

  function submit(e: Event) {
    e.preventDefault();
    if (!name) return;
    void onSave();
  }
</script>

<Modal bind:open>
  <div class="max-h-[80vh] overflow-y-auto">
    <form class="flex flex-col gap-4" onsubmit={submit}>
      <h3
        id="dialog-title"
        class="text-base font-semibold text-base-900 dark:text-base-100"
      >
        Edit {kind}
      </h3>
      <div class="mt-2">
        <p class="text-sm text-base-500 dark:text-base-400">
          Change the name of the {kind.toLowerCase()}
        </p>
      </div>
      <Input bind:value={name} placeholder="Name" type="text" required />

      {#if permissions}
        <div class="border-t border-base-200 dark:border-base-700 pt-4">
          {@render permissions()}
        </div>
      {/if}

      <div class="flex justify-start">
        <Button type="submit" disabled={!name} class="justify-start">
          <IconSave class="size-4" />
          Save
        </Button>
      </div>

      {#if canDelete && onDelete}
        <h3
          class="text-base font-semibold text-base-900 dark:text-base-100 mt-8"
        >
          Danger zone
        </h3>
        <div class="flex justify-start">
          <Button
            onclick={() => void onDelete()}
            class="justify-start"
            variant="red"
          >
            <IconTrash class="size-4" />
            Delete {kind}
          </Button>
        </div>
      {/if}
    </form>
  </div>
</Modal>
