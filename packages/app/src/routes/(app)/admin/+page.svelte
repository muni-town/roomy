<script lang="ts">
  import { navigateSync } from "$lib/utils.svelte";
  import { Button, Input } from "@fuxui/base";

  import { IDList, Space, allAccountsListId, allSpacesListId } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";
  import { co, Group } from "jazz-tools";

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

  let userId = $state("");

  async function giveAccess() {
    if(!userId) return;
    // get group of all spaces
    const allSpacesGroup = allSpaces.current?._owner.castAs(Group);;
    if(!allSpacesGroup) return;
    const allAccountsGroup = allAccounts.current?._owner.castAs(Group);
    if(!allAccountsGroup) return;

    const account = await co.account().load(userId);
    if(!account) return;

    allSpacesGroup.addMember(account, "admin");
    allAccountsGroup.addMember(account, "admin");

    console.log("done");
  }
</script>

<div class="flex flex-col gap-4 sm:pl-20 py-12 max-w-3xl mx-auto overflow-y-scroll h-screen text-base-900 dark:text-base-100">

  <div>Enter user id to give access to:</div>
  <Input bind:value={userId} />

  <Button onclick={() => {
    if(!userId) return;
    giveAccess();
  }}>
    Give access
  </Button>

  
  {#if usedSpaces.length > 0}
    <h2>Spaces with more than one member: {usedSpaces.length}</h2>
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
