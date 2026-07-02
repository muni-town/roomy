<script lang="ts">
  import type { Snippet } from "svelte";
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconSave, IconArchive, IconTrash } from "../../icons/index";

  let {
    open = $bindable(false),
    kind,
    name = $bindable(""),
    canDelete = false,
    permissions,
    onSave,
    onDelete,
    confirmArchive = $bindable(false),
    deleteLabel,
    deleteIcon = "archive",
    deleteConfirmTitle,
    deleteConfirmText,
    deleteConfirmButton,
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
    /** Button label for the delete action. Defaults to "Archive Channel". */
    deleteLabel?: string;
    /** Icon variant: "archive" (default) or "trash". */
    deleteIcon?: "archive" | "trash";
    /** Title of the confirmation modal. Defaults to "Archiving {kind}". */
    deleteConfirmTitle?: string;
    /** Body of the confirmation modal. Defaults to the archive warning. */
    deleteConfirmText?: Snippet;
    /** Confirm button label. Defaults to "Yes, Archive". */
    deleteConfirmButton?: string;
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
      <h1
        id="dialog-title"
        class="text-base font-bold text-xl text-base-900 dark:text-base-100"
      >
        Edit {kind}
      </h1>
      <div class="flex flex-col gap-1">
        <label
          for="create-room-name"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1"
        >
          {kind} Name
        </label>
        <Input bind:value={name} placeholder="Name" type="text" required />
      </div>
      {#if permissions}
        <div class="border-t border-base-200 dark:border-base-700 pt-6">
          {@render permissions()}
        </div>
      {/if}
      <div class="flex flex-row w-full justify-between mt-4">
        {#if canDelete && onDelete}
        <Button
          onclick={() => (confirmArchive = true)}
          class="justify-start"
          variant="red"
        >
          {#if deleteIcon === "trash"}
            <IconTrash class="size-4" />
          {:else}
            <IconArchive class="size-4" />
          {/if}
          {deleteLabel ?? "Archive Channel"}
        </Button>
        {/if}
        <Button type="submit" disabled={!name} class="justify-start ml-auto">
          <IconSave class="size-4" />
          Save
        </Button>
      </div>
    </form>
  </div>
</Modal>

{#if canDelete && onDelete}
  <Modal bind:open={confirmArchive} closeButton={true} class="gap-6">
    <div class="flex flex-col gap-2">
        <h1
          id="dialog-title"
          class="text-base font-bold text-xl text-base-900 dark:text-base-100"
        >
          {deleteConfirmTitle ?? `Archiving ${kind}`}
        </h1>
        <p class="text-base-800 dark:text-base-300 text-sm">
          {#if deleteConfirmText}
            {@render deleteConfirmText()}
          {:else}
            Are you sure you want to archive <b>{name}</b>? Archived channels
            aren't visible to non-admins. You can find and restore archived
            channels when editing the sidebar.
          {/if}
        </p>
    </div>
    <div class="flex flex-row w-full justify-between">
        <Button
          onclick={() => void onDelete() + (confirmArchive = false)}
          class="justify-start"
          variant="red"
        >
          {#if deleteIcon === "trash"}
            <IconTrash class="size-4" />
          {:else}
            <IconArchive class="size-4" />
          {/if}
          {deleteConfirmButton ?? "Yes, Archive"}
        </Button>
      <Button
        onclick={() => (confirmArchive = false)}
        class="justify-start"
        variant="primary"
      >
        Cancel
      </Button>
    </div>
  </Modal>
{/if}