<script lang="ts">
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "@fuxui/base";

  import { IDList, Space, allAccountsListId, allSpacesListId } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  // load all spaces and accounts
  const allSpaces = $derived(new CoState(IDList, allSpacesListId));
  const allAccounts = $derived(new CoState(IDList, allAccountsListId));


  let usedSpaces = $state<string[]>([]);
  async function addSpaces() {
    if(!allSpaces.current) return;
    if(usedSpaces.length > 0) return;

    // add all spaces with more than one member to the usedSpaces list
    for(const spaceId of allSpaces.current) {
      const space = await Space.load(spaceId, {
        resolve: {
          members: true
        }
      })
      if(space && space.members.length > 1) {
        usedSpaces.push(spaceId);
      }
    }
  }

  $effect(() => {
    addSpaces();
  })
</script>

<div class="flex flex-col gap-4 ml-20 overflow-y-scroll h-screen">
  {#if usedSpaces.length > 0}
    <h2>Used Spaces: {usedSpaces.length}</h2>
    {#each usedSpaces as spaceId}
      <Button href={navigateSync({ space: spaceId })}>
        {spaceId}
      </Button>
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
