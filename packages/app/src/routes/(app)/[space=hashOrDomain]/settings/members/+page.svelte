<script lang="ts">
  import { page } from "$app/state";
  import SettingsUser from "$lib/components/settings/SettingsUser.svelte";

  // let space = $derived(
  //   new CoState(RoomyEntity, page.params.space, {
  //     resolve: {
  //       components: {
  //         $each: true,
  //         $onError: null,
  //       },
  //     },
  //   }),
  // );

  // const me = new AccountCoState(RoomyAccount);

  // let members = $derived(
  //   new CoState(
  //     AllMembersComponent,
  //     space.current?.components?.[AllMembersComponent.id],
  //   ),
  // );

  // let users = $derived(
  //   Object.values(members.current?.perAccount ?? {})
  //     .filter((a) => a && !a.value?.softDeleted)
  //     .flat()
  //     .map((a) => a.value) || [],
  // );

  // let bans = $derived(
  //   new CoState(BansComponent, space.current?.components?.[BansComponent.id]),
  // );
  // let banSet = $derived(new Set(bans.current ?? []));
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Members
    </h2>

    <div class="flex flex-col gap-2">
      {#each users as member}
        {#if member?.account?.profile?.id}
          <SettingsUser
            space={space.current}
            isMe={me.current?.id === member?.id}
            accountId={member?.account?.id}
            isAdmin={false}
            isBanned={banSet.has(member?.account?.id)}
          />
        {/if}
      {/each}
    </div>
  </div>
</div>
