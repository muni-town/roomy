<script lang="ts">
  import type { InviteRow } from "@roomy/design/components/modals/InviteManager.svelte";
  import InviteManager from "@roomy/design/components/modals/InviteManager.svelte";
  import { toast } from "@foxui/core";
  import { createInvitesQuery } from "$lib/queries/invites";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createInvite, revokeInvite } from "$lib/mutations/invite";
  import { inviteUrl } from "$lib/share-links";

  let {
    open = $bindable(false),
    spaceId,
  }: {
    open: boolean;
    spaceId: string;
  } = $props();

  // The appserver refuses `getInvites` with 403 for a non-admin in a space
  // with member invites disabled (`handlers/space.roomy.space.getInvites.ts`)
  // and with 403 for a non-member outright. Enabling on `open` alone made
  // every modal open in such a space issue a request that could never
  // succeed, so the query is gated on the same predicate the sibling
  // settings route uses (`settings/invites/+page.svelte`) — the caller asks
  // the question only where the server can answer it. While metadata loads
  // the query stays disabled and enables itself the moment it lands.
  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const canViewInvites = $derived(
    (metaQuery.data?.isAdmin ?? false) ||
      ((metaQuery.data?.isMember ?? false) &&
        (metaQuery.data?.joinPolicy.allowMemberInvites ?? false)),
  );
  const invitesQuery = createInvitesQuery(() => spaceId, {
    enabled: () => open && canViewInvites,
  });

  let creating = $state(false);

  const invites = $derived<InviteRow[]>(
    invitesQuery.data?.invites ?? [],
  );

  // A caller the metadata denies does not get an invite surface at all: the
  // list is empty because it cannot be read, not because the space has no
  // invites, and Create would be refused by the same policy that hid the
  // list. Showing "No active invite links." with a live button turned that
  // refusal into silence — the button reported nothing when pressed.
  const invitesPermission = $derived(
    metaQuery.isPending
      ? ("checking" as const)
      : canViewInvites
        ? ("allowed" as const)
        : ("denied" as const),
  );

  function urlFor(token: string): string {
    return inviteUrl(spaceId, token);
  }

  async function onCreate() {
    creating = true;
    try {
      await createInvite(spaceId);
    } catch (e) {
      // The press was refused. Surface the reason the server gave rather
      // than leaving the modal unchanged and the button silent.
      toast.error(
        e instanceof Error ? e.message : "Couldn't create an invite link.",
      );
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
      toast.success("Invite link copied to clipboard");
    } catch {
      // Clipboard may not be available in all contexts.
    }
  }
</script>

<InviteManager
  bind:open
  {invites}
  {creating}
  {invitesPermission}
  {urlFor}
  {onCreate}
  {onRevoke}
  {onCopy}
/>
