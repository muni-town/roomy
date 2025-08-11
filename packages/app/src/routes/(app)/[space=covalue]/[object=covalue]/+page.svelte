<script lang="ts">
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import PageView from "$lib/components/content/page/PageView.svelte";
  import SidebarMain from "$lib/components/sidebars/SidebarMain.svelte";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  import FeedDisplay from "$lib/components/content/bluesky-feed/FeedDisplay.svelte";
  import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import {
    LastReadList,
    PageComponent,
    RoomyAccount,
    RoomyEntity,
    ThreadComponent,
  } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";

  let object = $derived(new CoState(RoomyEntity, page.params.object));

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: true,
      },
    },
  });

  let setLastRead = $state(false);

  $effect(() => {
    if (setLastRead) return;

    let objectId = page.params.object;
    if (objectId && me.current?.root?.lastRead === null) {
      me.current.root.lastRead = LastReadList.create({});
    }
    if (objectId && me.current?.root?.lastRead) {
      me.current.root.lastRead[objectId] = new Date();
      setLastRead = true;
    }
  });

  // Migration effect for feed configs
  $effect(() => {
    const objectId = page.params.object;
    if (objectId && object.current?.components?.feedConfig && me.current) {
      // Attempt to migrate old JSON config to new Jazz root structure
      atprotoFeedService.migrateEntityFeedConfig(me.current, objectId, object.current.components.feedConfig);
    }
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span>{object.current?.name || "..."}</span>
      </h2>
    </div>
  {/snippet}

  {#if object.current?.components?.feedConfig}
    <div class="flex-1 overflow-hidden">
      <FeedDisplay 
        objectId={page.params.object ?? ""} 
        singlePostUri={page.url.searchParams.get('thread') || undefined}
      />
    </div>
  {:else if object.current?.components?.[ThreadComponent.id]}
    <TimelineView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else if object.current?.components?.[PageComponent.id]}
    <PageView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else if object.current}
    <div class="flex-1 flex items-center justify-center">
      <h1
        class="text-2xl font-bold text-center text-base-900 dark:text-base-100"
      >
        Unknown object type
      </h1>
    </div>
  {:else}
    <div class="flex-1 flex items-center justify-center">
      <h1
        class="text-2xl font-bold text-center text-base-900 dark:text-base-100"
      >
        Object not found or you don't have permission to view it
      </h1>
    </div>
  {/if}
</MainLayout>
