<script lang="ts">
  import { page } from "$app/state";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import SpaceButton from "$lib/components/spaces/SpaceButton.svelte";
  import UserProfile from "$lib/components/user/UserProfile.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";

  const user = $derived(
    new CoState(RoomyAccount, page.params.user, {
      resolve: {
        profile: {
          newJoinedSpacesTest: true,
        },
      },
    }),
  );

  const userSpaceIds = $derived(
    user.current?.profile?.newJoinedSpacesTest?.map((space) => space?.id),
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        newJoinedSpacesTest: true,
      },
    },
  });

  const spacesInCommon = $derived(
    me.current?.profile?.newJoinedSpacesTest?.filter((space) =>
      userSpaceIds?.includes(space?.id),
    ),
  );
</script>

<MainLayout>
  <div class="flex flex-col gap-4 w-full h-full overflow-y-auto sm:px-4 pb-8">
    <UserProfile
      profile={{
        id: page.params.user,
        avatar: user.current?.profile?.imageUrl,
        displayName: user.current?.profile?.name,
        handle: user.current?.profile?.blueskyHandle,
        banner: user.current?.profile?.bannerUrl,
        description: user.current?.profile?.description,
      }}
    />

    <div class="flex flex-col gap-4 w-full max-w-4xl mx-auto px-4">
      {#if spacesInCommon?.length && spacesInCommon?.length > 0}
        <h2 class="text-3xl font-bold mb-8">Spaces in Common</h2>
        <section
          class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-8 max-w-5xl"
        >
          {#each spacesInCommon.toReversed() as space}
            <SpaceButton {space} />
          {/each}
        </section>
      {:else if spacesInCommon?.length === 0}
        <p class="text-lg font-medium text-center text-base-700 dark:text-base-300">
          You don't have any spaces in common with this user.
        </p>
      {/if}
    </div>
  </div>
</MainLayout>
