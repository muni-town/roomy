<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  let {
    profile,
  }: {
    profile: {
      id?: string;
      banner?: string;
      avatar?: string;
      displayName?: string;
      handle?: string;
      description?: string;
    };
  } = $props();
</script>

{#if profile}
  <div class={"mx-auto w-full max-w-full sm:max-w-2xl sm:py-6"}>
    <div>
      {#if profile.banner}
        <img
          class="aspect-[3/1] w-full border-b border-base-300 object-cover sm:rounded-xl sm:border"
          src={profile.banner}
          alt=""
        />
      {:else}
        <div class="aspect-[8/1] w-full"></div>
      {/if}
    </div>
    <div
      class={[
        profile.banner ? "-mt-11" : "-mt-8",
        "flex max-w-full items-end space-x-5 px-4 sm:-mt-16 sm:px-6 lg:px-8",
      ]}
    >
      <Avatar.Root class="size-24 sm:size-32">
        <Avatar.Image src={profile?.avatar} class="rounded-full" />
        <Avatar.Fallback>
          <AvatarBeam name={profile.id} />
        </Avatar.Fallback>
      </Avatar.Root>
      <div
        class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6 sm:pb-1"
      >
        <div
          class={[
            profile.banner ? "mt-4 sm:mt-0" : "-mt-[4.5rem] sm:-mt-[6.5rem]",
            "flex min-w-0 max-w-full flex-1 flex-col items-baseline",
          ]}
        >
          <h1
            class="max-w-full truncate text-lg font-bold text-primary sm:text-xl"
          >
            {profile.displayName || profile.handle}
          </h1>
        </div>
      </div>
    </div>

    {#if profile.description}
      <div
        class="px-4 sm:px-6 lg:px-8 py-4 text-xs sm:text-sm text-base-900"
      >
        {@html profile.description?.replaceAll("\n", "<br/>")}
      </div>
    {/if}
  </div>
{/if}
