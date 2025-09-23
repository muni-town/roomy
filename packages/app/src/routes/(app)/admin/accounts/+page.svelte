<script lang="ts">
  import { Badge, toast } from "@fuxui/base";
  import SettingsUser from "$lib/components/settings/SettingsUser.svelte";

  // load all spaces and accounts
  const allSpaces = $derived(new CoState(IDList, allSpacesListId));
  const allAccounts = $derived(new CoState(IDList, allAccountsListId));

  const accountSet = $derived(new Set(allAccounts.current?.toReversed()));

  async function giveAccess(userId: string) {
    const allSpacesGroup = allSpaces.current?._owner.castAs(Group);
    if (!allSpacesGroup) return;
    const allAccountsGroup = allAccounts.current?._owner.castAs(Group);
    if (!allAccountsGroup) return;

    const account = await co.account().load(userId);
    if (!account) return;

    allSpacesGroup.addMember(account, "admin");
    allAccountsGroup.addMember(account, "admin");

    toast.success("Access granted");
  }

  let hasAccess = $derived(
    new Set(allAccounts.current?._owner.castAs(Group).members.map((m) => m.id)),
  );
</script>

{#if allAccounts.current}
  <h2 class="mb-8 text-lg font-semibold text-base-900 dark:text-base-100">
    All Accounts <Badge size="md">{accountSet.size}</Badge>
  </h2>
  <div class="flex flex-col gap-2">
    {#each accountSet as accountId}
      <SettingsUser
        {accountId}
        space={undefined}
        makeAdmin={() => {
          giveAccess(accountId);
        }}
        isAdmin={hasAccess.has(accountId)}
      />
    {/each}
  </div>
{/if}
