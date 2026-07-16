<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import ThemeSettings from "@roomy/design/components/user/ThemeSettings.svelte";
  import { IconArrowLeft } from "@roomy/design/icons";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebar } from "$lib/components/layout/sidebar.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { joinSpace } from "$lib/mutations/space";
  import { queryClient } from "$lib/client";
  import { cache } from "@roomy-space/sdk";
  import { resolveBlobUrl } from "$lib/utils";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { isPushFeatureEnabled } from "$lib/push.svelte";

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  let pushFeatureEnabled = $state(false);
  let rejoining = $state<string | null>(null);

  async function rejoin(spaceId: string) {
    rejoining = spaceId;
    try {
      await joinSpace(spaceId);
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.space.getSpaces"),
      });
    } catch (e) {
      console.error("Failed to rejoin space", e);
    } finally {
      rejoining = null;
    }
  }

  onMount(() => {
    setNavbar(settingsNavbar);
    setSidebar(settingsSidebar);
    isPushFeatureEnabled().then((enabled) => {
      pushFeatureEnabled = enabled;
    });
    return () => {
      setNavbar(undefined);
      setSidebar(undefined);
    };
  });
</script>

{#snippet settingsNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    User settings
  </div>
{/snippet}

{#snippet settingsSidebar()}
  <div class="flex flex-col h-full">
    <div class="p-3">
      <Button class="w-full justify-start" href="/" variant="ghost">
        <IconArrowLeft class="size-4" />
        Back to home
      </Button>
    </div>
    <div class="flex flex-col gap-1 px-3">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500 px-2">
        Settings
      </span>
      <Button
        variant="ghost"
        class="w-full justify-start"
        href="/user/settings"
        data-current={page.url.pathname === "/user/settings"}
      >
        General
      </Button>
      {#if pushFeatureEnabled}
        <Button
          variant="ghost"
          class="w-full justify-start"
          href="/user/settings/notifications"
          data-current={page.url.pathname === "/user/settings/notifications"}
        >
          Notifications
        </Button>
      {/if}
    </div>
  </div>
{/snippet}

<ScrollArea class="h-full">
  <div class="max-w-3xl mx-auto w-full p-4 flex flex-col gap-10">
    <!-- Theme section -->
    <section>
      <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100">
        Theme
      </h2>
      <ThemeSettings />
    </section>

    <!-- Left Spaces section -->
    <section>
      <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100">
        Left Spaces
      </h2>

      {#if spacesQuery.isPending}
        <p class="text-sm text-base-400">Loading spaces…</p>
      {:else if spacesQuery.isError}
        <ErrorMessage message="Error: {spacesQuery.error.message}" class="py-8" />
      {:else if spacesQuery.data}
        {@const left = spacesQuery.data.spaces.filter((s: { isMember: boolean }) => !s.isMember)}

        {#if left.length === 0}
          <p class="text-sm text-base-400">No left spaces.</p>
        {:else}
          <div class="flex flex-row gap-6 flex-wrap">
            {#each left as space (space.id)}
              <div
                class="flex flex-col items-center gap-2 w-32 opacity-85 hover:opacity-100 transition-opacity"
              >
                <SpaceAvatar
                  src={resolveBlobUrl(space.avatar)}
                  id={space.id}
                  name={space.name ?? undefined}
                  size={64}
                />
                <span
                  class="text-sm font-medium text-center text-base-700 dark:text-base-300 line-clamp-2"
                >
                  {space.name || "Unnamed Space"}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => rejoin(space.id)}
                  disabled={rejoining === space.id}
                >
                  {rejoining === space.id ? "Joining…" : "Rejoin"}
                </Button>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  </div>
</ScrollArea>
