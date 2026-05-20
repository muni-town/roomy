<script lang="ts">
  import { page } from "$app/state";
  import InviteManager from "@roomy/design/components/modals/InviteManager.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { createInvitesQuery } from "$lib/queries/invites";
  import { createInvite, revokeInvite } from "$lib/mutations/invite";

  const spaceId = $derived(page.params.space!);
  const invitesQuery = createInvitesQuery(() => spaceId);

  let open = $state(false);
  let creating = $state(false);

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

  function onRevoke(token: string) {
    revokeInvite(spaceId, token).catch(() => {});
  }

  function onCopy(token: string) {
    navigator.clipboard.writeText(urlFor(token)).catch(() => {});
  }
</script>

<div class="max-w-2xl">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-base font-semibold">Invites</h2>
    <Button onclick={() => (open = true)}>Manage invites</Button>
  </div>

  {#if invitesQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if invitesQuery.isError}
    <p class="text-sm text-red-600">{invitesQuery.error.message}</p>
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
