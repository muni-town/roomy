<script lang="ts">
  import UserAvatar from "./UserAvatar.svelte";

  // Props
  let {
    profile,
  }: {
    profile: {
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

<div class="mx-auto w-full max-w-full sm:max-w-2xl sm:py-6">
  <div>
    {#if profile?.banner}
      <img
        class="aspect-[3/1] w-full border border-base-300 dark:border-base-800 object-cover sm:rounded-xl sm:border"
        src={profile.banner}
        alt=""
      />
    {:else}
      <div class="aspect-[3/1] w-full bg-accent-100 dark:bg-base-900 border border-base-300 dark:border-base-800 object-cover sm:rounded-xl sm:border"></div>
    {/if}
  </div>
  <div
    class={[
      profile?.banner ? "-mt-8" : "-mt-8",
      "flex max-w-full items-end space-x-4 px-4 sm:-mt-6 sm:px-6 lg:px-4",
    ]}
  >
    <UserAvatar
      src={profile?.avatar}
      name={profile?.did || profile?.handle || "unknown"}
      class="size-22 sm:size-20 outline rounded-full outline-base-100 dark:outline-base-950"
    />

    <div
      class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6"
    >
      <div
        class={[
          profile?.banner,
          "flex min-w-0 max-w-full flex-1 flex-col items-baseline",
        ]}
      >
        <h1
          class="max-w-full truncate text-xl font-bold text-base-900 dark:text-base-100 sm:text-xl"
        >
          {profile?.displayName || profile?.handle}
        </h1>
        {#if profile?.handle}
          <a
            href="https://aturi.to/{profile.did}"
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
    <div
      class="px-6 sm:px-4 lg:px-6 py-4 text-sm sm:text-sm text-base-900 dark:text-base-100 prose prose-sm dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400"
    >
      {@html linkifyText(profile.description)}
    </div>
  {/if}
</div>
