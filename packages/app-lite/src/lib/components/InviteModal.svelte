<script lang="ts">
  import type { InviteRow } from "@roomy/design/components/modals/InviteManager.svelte";
  import InviteManager from "@roomy/design/components/modals/InviteManager.svelte";
  import { createInvitesQuery } from "$lib/queries/invites";
  import { createInvite, revokeInvite } from "$lib/mutations/invite";

  let {
    open = $bindable(false),
    spaceId,
  }: {
    open: boolean;
    spaceId: string;
  } = $props();

  const invitesQuery = createInvitesQuery(() => spaceId);

  let creating = $state(false);

  const invites = $derived<InviteRow[]>(
    invitesQuery.data?.invites ?? [],
  );

  function urlFor(token: string): string {
    return `${location.origin}/join?space=${encodeURIComponent(spaceId)}&invite=${encodeURIComponent(token)}`;
  }

  async function onCreate() {
    creating = true;
    try {
      await createInvite(spaceId);
    } finally {
      creating = false;
    }
  }

  async function onRevoke(token: string) {
    try {
      await revokeInvite(spaceId, token);
    } catch {
      // Silently fail — the manager renders the button regardless.
    }
  }

  async function onCopy(token: string) {
    try {
      await navigator.clipboard.writeText(urlFor(token));
    } catch {
      // Clipboard may not be available in all contexts.
    }
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
