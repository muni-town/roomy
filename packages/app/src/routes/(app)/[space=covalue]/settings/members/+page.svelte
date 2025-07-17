<script lang="ts">
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import { Group, makeSpaceAdmin, RoomyAccount, Space } from "@roomy-chat/sdk";
  import { page } from "$app/state";
  import SettingsUser from "$lib/components/settings/SettingsUser.svelte";
  import toast from "svelte-french-toast";

  let space = $derived(new CoState(Space, page.params.space));

  const me = new AccountCoState(RoomyAccount);

  let members = $derived(space.current?.members ?? []);
  let bans = $derived(space.current?.bans ?? []);
  let banSet = $derived(new Set(bans));
  let adminGroup = $derived(new CoState(Group, space.current?.adminGroupId));
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Members
    </h2>

    <div class="flex flex-col gap-2">
      {#each members as member}
        {#if member?.profile?.id}
          <SettingsUser
            space={space.current}
            isMe={me.current?.id === member?.id}
            accountId={member?.id}
            isAdmin={adminGroup.current?.members?.some(
              (m) => m?.id === member?.id,
            ) ?? false}
            isBanned={banSet.has(member?.id)}
            makeAdmin={() => {
              if (space.current?.id && member?.id) {
                makeSpaceAdmin(space.current?.id, member?.id);
                toast.success("User made admin");
              }
            }}
          />
        {/if}
      {/each}
    </div>
  </div>
</div>
