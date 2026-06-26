<script lang="ts">
  import type { Snippet } from "svelte";
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconSave, IconTrash, IconArchive } from "../../icons/index";

  let {
    open = $bindable(false),
    kind,
    name = $bindable(""),
    canDelete = false,
    permissions,
    onSave,
    onDelete,
    confirmArchive = $bindable(false),
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
      <h1
        id="dialog-title"
        class="text-base font-bold text-xl text-base-900 dark:text-base-100"
      >
        {kind} Overview
      </h1>
      <div class="flex flex-col gap-1">
      <label
        for="create-room-name"
        class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1"
      >
        Channel Name
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
          <IconArchive class="size-4" />
            Archive Channel
          </Button>
          <Button type="submit" disabled={!name} class="justify-start">
            <IconSave class="size-4" />
            Save
          </Button>
          <Modal bind:open={confirmArchive} closeButton={true} class="gap-6">
            <div class="flex flex-col gap-2">
              <h1
                id="dialog-title"
                class="text-base font-bold text-xl text-base-900 dark:text-base-100"
              >
                Archiving {kind}
              </h1>
              <p class="text-base-800 dark:text-base-300 text-sm">
                Are you sure you want to archive <b>{name}</b>? Archived channels aren't visible to non-admins. If you want to permanently delete channels, you'll need to archive them first.
                <br/><br/>
                You can always retrieve archived channels in <b>… -> Edit Sidebar</b>.
              </p>
            </div>
            <div class="flex flex-row w-full justify-between">
              <Button
                onclick={() => void onDelete() + (confirmArchive = false)}
                class="justify-start"
                variant="red"
              >
              <IconArchive class="size-4" />
              Yes, Archive
            </Button>
            <Button
              onclick={() => (confirmArchive = false)}
              class="justify-start"
              variant="primary"
            >
              Cancel
            </Button>
          </Modal>
    {/if}
      </div>
    </form>
  </div>
</Modal>
