<script lang="ts">
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import { RoomyAccount, Space } from "@roomy-chat/sdk";
  import { page } from "$app/state";
  import SettingsUser from "$lib/components/settings/SettingsUser.svelte";

  let space = $derived(new CoState(Space, page.params.space));

  const me = new AccountCoState(RoomyAccount);

  let members = $derived(space.current?.members ?? []);
  let bans = $derived(space.current?.bans ?? []);
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Members
    </h2>

    <div class="flex flex-col gap-2">
      {#each members as member}
        {#if member?.profile?.id}
          <div class="flex items-center gap-2">
            <SettingsUser
              isMe={me.current?.id === member?.id}
              profileId={member?.profile?.id}
              accountId={member?.id}
            />
          </div>
        {/if}
      {/each}
    </div>
  </div>
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Bans
    </h2>

    {#each bans as ban}
      <div>
        <div>{ban}</div>
      </div>
    {/each}
    {#if bans.length === 0}
      <p class="text-sm italic text-base-500 dark:text-base-400">No bans</p>
    {/if}
  </div>
</div>
