<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import { Box, Button } from "@fuxui/base";
  import type { IncomingEvent } from "@muni-town/leaf-client";
  import { ulid } from "ulidx";
  // import { ulid } from "ulidx";

  async function navigateToFirstChildThreadOrPage() {}

  // Automatically navigate to the first object that is a thread or page in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    navigateToFirstChildThreadOrPage();
  });

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  let events: IncomingEvent[] = $state([]);

  // fetch first 100 events
  async function fetchEvents() {
    if (!backendStatus.personalStreamId || !page.params.space) return;
    console.log("Fetching events for space", page.params.space);
    events = await backend.fetchEvents(page.params.space, 1, 100);
    $state.snapshot(events);
    await backend.previewSpace(page.params.space);
    console.log("Space preview materialised");
  }

  fetchEvents();

  async function joinSpace() {
    if (!backendStatus.personalStreamId || !page.params.space) return;
    await backend.sendEvent(backendStatus.personalStreamId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.join.0",
        data: {
          spaceId: page.params.space,
        },
      },
    });
  }

  $effect(() => {
    $inspect(current);
  });
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

<MainLayout sidebar={current.space ? (sidebar as any) : undefined}>
  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span>{current.space?.name}</span>
        <div class="ml-2 font-bold grow text-center">All Threads</div>
      </h2>
    </div>
  {/snippet}

  {#if !current.space}
    <div class="flex items-center justify-center h-full">
      <Box class="w-[20em] flex flex-col">
        <div class="mb-5 flex justify-center items-center gap-3">
          <SpaceAvatar
            imageUrl={inviteSpaceAvatar ?? ""}
            id={page.params.space}
            name={inviteSpaceName ?? ""}
            size={50}
          />
          {#if inviteSpaceName}
            <h1 class="font-bold text-xl">{inviteSpaceName}</h1>
          {/if}
        </div>
        <Button size="lg" onclick={joinSpace}>Join Space</Button>
      </Box>
    </div>
  {:else}
    <div class="flex-1 flex items-center justify-center">
      <!-- {#if subthreadEnts.current}
        <ScrollArea class="h-full px-2 pb-4">
          {#each sortedSubthreads as subthread}
            {#if subthread}
              <div class="mt-4">
                <BoardViewItem thread={subthread} />
              </div>
            {/if}
          {/each}
        </ScrollArea>
      {:else}
        No threads in this Channel.
      {/if} -->
    </div>
  {/if}
</MainLayout>
