<script lang="ts">
  import { page } from "$app/state";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import Icon from "@iconify/svelte";
  import { AccountCoState, CoState } from "jazz-svelte";
  import { AtpBaseClient } from "@atproto/api";
  import { user } from "$lib/user.svelte";

  let agent: AtpBaseClient | undefined = undefined;

  export async function resolveHandle({ handle }: { handle: string }) {
    if (!agent) {
      agent = new AtpBaseClient({ service: "https://public.api.bsky.app" });
    }

    const data = await agent.com.atproto.identity.resolveHandle({ handle });
    return data.data.did;
  }

  async function getProfileRecord(handle: string) {
    if (!agent) {
      agent = new AtpBaseClient({ service: "https://public.api.bsky.app" });
    }

    const did = await resolveHandle({ handle });

    return await user.agent?.com.atproto.repo.getRecord({
      collection: "chat.roomy.profile",
      repo: did,
      rkey: "self",
    });
  }

  let accountId: string | undefined = $state(undefined);

  $effect(() => {
    if (!accountId) {
      getProfileRecord(page.params.user as string).then((record) => {
        accountId = record?.data?.value?.accountId as string;
      });
    }
  });

  const profile = $derived(
    new CoState(RoomyAccount, accountId, {
      resolve: {
        profile: {
          joinedSpaces: true,
        },
      },
    }),
  );

  const userSpaceIds = $derived(
    profile.current?.profile?.joinedSpaces?.map((space) => space?.id),
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

<div class="flex flex-col gap-4 w-full overflow-y-auto">
  <!-- TODO: Re-implement User Profile -->
  <!-- <UserProfile
    profile={{
      id: profile.current?.profile?.id,
      avatar: profile.current?.profile?.imageUrl,
      displayName: profile.current?.profile?.name,
      handle: profile.current?.profile?.blueskyHandle,
      banner: profile.current?.profile?.bannerUrl,
      description: profile.current?.profile?.description,
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
