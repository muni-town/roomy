<script lang="ts">
  import { IDList } from "$lib/jazz/schema";
  import { allAccountsListId, allSpacesListId } from "$lib/jazz/ids";
  import { CoState } from "jazz-svelte";

  // load all spaces and accounts
  const allSpaces = $derived(new CoState(IDList, allSpacesListId));
  const allAccounts = $derived(new CoState(IDList, allAccountsListId));
</script>

<div class="flex flex-col gap-4">
  {#if allSpaces.current}
    <h2>All Spaces: {allSpaces.current.length}</h2>
    {#each allSpaces.current as spaceId}
      <div>
        {spaceId}
      </div>
    {/each}
  {/if}

  {#if allAccounts.current}
    <h2>All Accounts: {allAccounts.current.length}</h2>
    {#each allAccounts.current as accountId}
      <div>
        {accountId}
      </div>
    {/each}
  {/if}
</div>
