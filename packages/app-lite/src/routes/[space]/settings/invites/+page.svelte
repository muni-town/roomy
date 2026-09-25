<script lang="ts">
  import { page } from "$app/state";
  import InviteManager from "@roomy/design/components/modals/InviteManager.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { createInvitesQuery } from "$lib/queries/invites";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createInvite, revokeInvite } from "$lib/mutations/invite";
  import { inviteUrl } from "$lib/share-links";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  // The appserver rejects `getInvites` with 403 for a non-admin in a space
  // with member invites disabled (`handlers/space.roomy.space.getInvites.ts`)
  // and with 403 for a non-member outright — a request that can never succeed
  // for that caller. Gate the query on the same condition the server applies,
  // so the page never asks a question whose answer cannot exist. The sidebar
  // hides the tab under this predicate; this covers direct navigation too.
  // While metadata loads the query stays disabled and enables itself the
  // moment it lands.
  const canViewInvites = $derived(
    (metaQuery.data?.isAdmin ?? false) ||
      ((metaQuery.data?.isMember ?? false) &&
        (metaQuery.data?.joinPolicy.allowMemberInvites ?? false)),
  );
  const invitesQuery = createInvitesQuery(() => spaceId, {
    enabled: () => canViewInvites,
  });

  let open = $state(false);
  let creating = $state(false);

  function urlFor(token: string): string {
    return inviteUrl(spaceId, token);
  }

  async function onCreate() {
    creating = true;
    try {
      await createInvite(spaceId);
    } finally {
      creating = false;
    }
  }

  function onRevoke(token: string) {
    revokeInvite(spaceId, token).catch(() => {});
  }

  function onCopy(token: string) {
    navigator.clipboard.writeText(urlFor(token)).catch(() => {});
  }
</script>

<div class="max-w-2xl">
  {#if metaQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if !canViewInvites}
    <p class="text-sm text-base-400 py-8">
      You do not have permission to manage invites for this space.
    </p>
  {:else}
    <div class="flex justify-end mb-3">
      <Button onclick={() => (open = true)}>Manage invites</Button>
    </div>

    {#if invitesQuery.isPending}
      <p class="text-sm text-base-400">Loading…</p>
    {:else if invitesQuery.isError}
      <ErrorMessage message={invitesQuery.error.message} class="py-8" />
    {:else if invitesQuery.data}
      {@const invites = invitesQuery.data.invites}
      {#if invites.length === 0}
        <p class="text-sm text-base-400">No active invites.</p>
      {:else}
        <ul class="space-y-2">
          {#each invites as inv (inv.token)}
            <li class="p-3 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
              <div class="font-mono text-xs break-all">{urlFor(inv.token)}</div>
              <div class="text-[11px] text-base-400 mt-1">created by {inv.createdBy}</div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>

<InviteManager
  bind:open
  invites={invitesQuery.data?.invites ?? []}
  {creating}
  {urlFor}
  {onCreate}
  {onRevoke}
  {onCopy}
/>
