<script lang="ts" module>
  export type InviteRow = {
    token: string;
    createdBy: string;
    eventUlid: string;
  };
</script>

<script lang="ts">
  import { Modal } from "@foxui/core";
  import Button from "../ui/button/Button.svelte";
  import { IconCopy, IconTrash, IconPlus } from "../../icons/index";

  let {
    open = $bindable(false),
    invites,
    creating = false,
    urlFor,
    onCreate,
    onRevoke,
    onCopy,
  }: {
    open: boolean;
    invites: InviteRow[];
    creating?: boolean;
    /** Build the shareable URL for an invite token. */
    urlFor: (token: string) => string;
    onCreate: () => void;
    onRevoke: (token: string) => void;
    onCopy: (token: string) => void;
  } = $props();
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4 min-w-80">
    <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
      Invite people
    </h3>
    <p class="text-sm text-base-600 dark:text-base-400">
      Share an invite link to let others join this space.
    </p>

    <div class="flex flex-col gap-2">
      {#each invites as invite (invite.token)}
        <div
          class="flex items-center gap-2 rounded-lg border border-base-200 dark:border-base-700 px-3 py-2"
        >
          <span
            class="font-mono text-xs text-base-700 dark:text-base-300 truncate grow"
          >
            {urlFor(invite.token)}
          </span>
          <button
            onclick={() => onCopy(invite.token)}
            class="shrink-0 text-base-500 hover:text-base-900 dark:hover:text-base-100 transition-colors"
            title="Copy link"
          >
            <IconCopy class="size-4" />
          </button>
          <button
            onclick={() => onRevoke(invite.token)}
            class="shrink-0 text-base-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            title="Revoke link"
          >
            <IconTrash class="size-4" />
          </button>
        </div>
      {/each}

      {#if invites.length === 0}
        <p class="text-sm text-base-500 dark:text-base-500 text-center py-2">
          No active invite links.
        </p>
      {/if}
    </div>

    <Button onclick={onCreate} disabled={creating} class="w-full">
      <IconPlus class="size-4" />
      {creating ? "Creating…" : "Create invite link"}
    </Button>
  </div>
</Modal>
