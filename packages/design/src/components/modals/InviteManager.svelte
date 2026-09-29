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
    invitesPermission = "allowed",
    urlFor,
    onCreate,
    onRevoke,
    onCopy,
  }: {
    open: boolean;
    invites: InviteRow[];
    creating?: boolean;
    /**
     * Whether the caller may see and create invites. The appserver answers
     * `getInvites` with 403 and refuses `createInvite` for a non-admin in a
     * space with member invites disabled, so a surface that cannot read the
     * list must not offer the button either — a live button whose press is
     * refused reports nothing. `"checking"` covers the window before the
     * metadata that decides this has loaded.
     */
    invitesPermission?: "allowed" | "denied" | "checking";
    /** Build the shareable URL for an invite token. */
    urlFor: (token: string) => string;
    onCreate: () => void;
    onRevoke: (token: string) => void;
    onCopy: (token: string) => void;
  } = $props();

  /** Only a caller allowed the list sees it — an empty one is not a truth here. */
  const showList = $derived(invitesPermission === "allowed");
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4 min-w-80">
    <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
      Invite people
    </h3>
    {#if invitesPermission === "denied"}
      <p class="text-sm text-base-600 dark:text-base-400">
        You do not have permission to manage invites for this space.
      </p>
    {:else if invitesPermission === "checking"}
      <p class="text-sm text-base-500 dark:text-base-500">Loading…</p>
    {:else}
      <p class="text-sm text-base-600 dark:text-base-400">
        Share an invite link to let others join this space.
      </p>
    {/if}

    {#if showList}
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
    {/if}

    {#if invitesPermission === "allowed"}
      <Button onclick={onCreate} disabled={creating} class="w-full">
        <IconPlus class="size-4" />
        {creating ? "Creating…" : "Create invite link"}
      </Button>
    {/if}
  </div>
</Modal>
