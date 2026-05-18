<script lang="ts">
  import { toast } from "@foxui/core";
  import InviteManager, {
    type InviteRow,
  } from "@roomy/design/components/modals/InviteManager.svelte";
  import { getAppState } from "$lib/queries";
  import { peer, peerStatus } from "$lib/workers";
  import { newUlid } from "@roomy-space/sdk";
  import { page } from "$app/state";
  import type { StreamDid } from "@roomy-space/sdk";

  let { open = $bindable(false) }: { open: boolean } = $props();

  const app = getAppState();

  let spaceId = $derived(app.joinedSpace?.id);
  let spaceParam = $derived(app.joinedSpace?.handle ?? page.params.space);

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

  function urlFor(token: string) {
    const url = new URL(page.url.href);
    url.pathname = `/${spaceParam}`;
    url.search = `?invite=${token}`;
    return url.href;
  }

  async function onCreate() {
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
      await loadInvites();
    }
  }

  async function onRevoke(token: string) {
    if (!spaceId || peerStatus.roomyState?.state !== "connected") return;
    await peer.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.revokeInvite.v0",
      token,
    });
    await loadInvites();
  }

  function onCopy(token: string) {
    navigator.clipboard.writeText(urlFor(token));
    toast.success("Invite link copied to clipboard");
  }
</script>

<InviteManager
  bind:open
  {invites}
  {creating}
  {urlFor}
  {onCreate}
  {onRevoke}
  {onCopy}
/>
