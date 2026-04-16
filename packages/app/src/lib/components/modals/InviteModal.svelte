<script lang="ts">
  import { Modal, Button, toast } from "@foxui/core";
  import { getAppState } from "$lib/queries";
  import { peer, peerStatus } from "$lib/workers";
  import { newUlid } from "@roomy-space/sdk";
  import { page } from "$app/state";
  import { IconCopy, IconTrash, IconPlus } from "@roomy/design/icons";
  import type { StreamDid } from "@roomy-space/sdk";

  let { open = $bindable(false) }: { open: boolean } = $props();

  const app = getAppState();

  let spaceId = $derived(app.joinedSpace?.id);
  let spaceParam = $derived(app.joinedSpace?.handle ?? page.params.space);

  type InviteRow = { token: string; createdBy: string; eventUlid: string };

  let invites = $state<InviteRow[]>([]);
  let creating = $state(false);

  async function loadInvites() {
    if (!spaceId || peerStatus.roomyState?.state !== "connected") return;
    invites = await peer.getInvites(spaceId as StreamDid);
  }

  $effect(() => {
    if (open && spaceId) {
      loadInvites();
    }
  });

  function inviteUrl(token: string) {
    const url = new URL(page.url.href);
    url.pathname = `/${spaceParam}`;
    url.search = `?invite=${token}`;
    return url.href;
  }

  async function createInvite() {
    if (!spaceId || peerStatus.roomyState?.state !== "connected") return;
    creating = true;
    try {
      const token = crypto.randomUUID();
      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.createInvite.v0",
        token,
      });
    } finally {
      creating = false;
    }
  }

  async function revokeInvite(token: string) {
    if (!spaceId || peerStatus.roomyState?.state !== "connected") return;
    await peer.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.revokeInvite.v0",
      token,
    });
  }

  function copyInvite(token: string) {
    navigator.clipboard.writeText(inviteUrl(token));
    toast.success("Invite link copied to clipboard");
  }
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
            {inviteUrl(invite.token)}
          </span>
          <button
            onclick={() => copyInvite(invite.token)}
            class="shrink-0 text-base-500 hover:text-base-900 dark:hover:text-base-100 transition-colors"
            title="Copy link"
          >
            <IconCopy class="size-4" />
          </button>
          <button
            onclick={() => revokeInvite(invite.token)}
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

    <Button onclick={createInvite} disabled={creating} class="w-full">
      <IconPlus class="size-4" />
      {creating ? "Creating…" : "Create invite link"}
    </Button>
  </div>
</Modal>
