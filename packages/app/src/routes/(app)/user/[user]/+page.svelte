<script lang="ts">
  import { page } from "$app/state";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import Icon from "@iconify/svelte";
  import { AccountCoState, CoState } from "jazz-svelte";

  const user = $derived(
    new CoState(RoomyAccount, page.params.user, {
      resolve: {
        profile: {
          joinedSpaces: true,
        },
      },
    }),
  );

  const userSpaceIds = $derived(
    user.current?.profile?.joinedSpaces?.map((space) => space?.id),
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: true,
      },
    },
  });

  const spacesInCommon = $derived(
    me.current?.profile?.joinedSpaces?.filter((space) =>
      userSpaceIds?.includes(space?.id),
    ),
  );
</script>

<div class="flex flex-col gap-4 w-full h-full overflow-y-auto sm:pl-18">
  <!-- TODO: re-implement user profile -->
  <!-- <UserProfile
    profile={{
      id: page.params.user, // Use the account ID from URL
      avatar: user.current?.profile?.imageUrl,
      displayName: user.current?.profile?.name,
      handle: user.current?.profile?.blueskyHandle,
      banner: user.current?.profile?.bannerUrl,
      description: user.current?.profile?.description,
    }}
  /> -->

  <div class="flex flex-col gap-4 w-full max-w-4xl mx-auto px-4">
    {#if spacesInCommon?.length && spacesInCommon?.length > 0}
      <h2 class="text-3xl font-bold">Spaces in Common</h2>
      <section class="flex flex-wrap justify-center gap-4 max-w-5xl">
        {#each spacesInCommon as space}
          <a
            href={`/${space?.id}`}
            class="dz-card border border-base-300 hover:border-primary bg-base-100 transition-colors cursor-pointer text-base-content w-full md:w-96"
          >
            <div class="dz-card-body flex-row items-center justify-between">
              <h2 class="dz-card-title">{space?.name}</h2>
              <div class="dz-card-actions">
                <Icon
                  icon="lucide:circle-arrow-right"
                  class="text-2xl text-primary"
                />
              </div>
            </div>
          </a>
        {/each}
      </section>
    {:else if spacesInCommon?.length === 0}
      <p class="text-lg font-medium text-center">
        You don't have any spaces in common with this user.
      </p>
    {/if}
  </div>
</div>
