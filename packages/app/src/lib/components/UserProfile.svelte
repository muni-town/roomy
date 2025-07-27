<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  // Props
  let {
    profile,
  }: {
    profile: {
      id?: string;
      did?: string;
      handle?: string;
      displayName?: string;
      avatar?: string;
      banner?: string;
      description?: string;
      accountId?: string;
    };
  } = $props();

  // Function to convert URLs in text to clickable links
  function linkifyText(text: string): string {
    const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
    return text
      .replaceAll("\n", "<br/>")
      .replace(
        urlRegex,
        '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-primary hover:text-primary-focus underline hover:no-underline transition-colors font-medium">$1</a>',
      );
  }
</script>

<div class="mx-auto w-full max-w-full sm:max-w-4xl sm:py-6">
  <div>
    {#if profile?.banner}
      <img
        class="aspect-[3/1] w-full border-b border-base-300 dark:border-base-700 object-cover sm:rounded-xl sm:border"
        src={profile.banner}
        alt=""
      />
    {:else}
      <div class="aspect-[8/1] w-full"></div>
    {/if}
  </div>
  <div
    class={[
      profile?.banner ? "-mt-11" : "-mt-8",
      "flex max-w-full items-end space-x-5 px-4 sm:-mt-16 sm:px-6 lg:px-8",
    ]}
  >
    <Avatar.Root class="size-24 sm:size-32">
      <Avatar.Image src={profile?.avatar} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam name={profile?.did || profile?.handle || "unknown"} />
      </Avatar.Fallback>
    </Avatar.Root>

    <div
      class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6 sm:pb-1"
    >
      <div
        class={[
          profile?.banner ? "mt-4 sm:mt-0" : "-mt-[4.5rem] sm:-mt-[6.5rem]",
          "flex min-w-0 max-w-full flex-1 flex-col items-baseline",
        ]}
      >
        <h1
          class="max-w-full truncate text-lg font-bold text-base-900 dark:text-base-100 sm:text-xl"
        >
          {profile?.displayName || profile?.handle}
        </h1>
        {#if profile?.handle}
          <a
            href="https://bsky.app/profile/{profile.handle}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-accent-600 dark:text-accent-400 transition-colors font-medium"
          >
            @{profile.handle}
          </a>
        {/if}
      </div>
    </div>
  </div>

  {#if profile?.description}
    <div class="px-4 sm:px-6 lg:px-8 py-4 text-xs sm:text-sm text-base-900 prose prose-sm dark:prose-invert prose-a:no-underline prose-a:text-accent-600 dark:prose-a:text-accent-400">
      {@html linkifyText(profile.description)}
    </div>
  {/if}
</div>
