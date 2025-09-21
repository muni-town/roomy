<script lang="ts">
  import { page } from "$app/state";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";

  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  // import PageView from "$lib/components/content/page/PageView.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Ulid } from "$lib/workers/encoding";
  import { Tabs } from "@fuxui/base";
  // import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  // import FeedDisplay from "$lib/components/content/bluesky-feed/FeedDisplay.svelte";
  // import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  // import { Tabs } from "@fuxui/base";
  // import BoardView from "$lib/components/content/thread/BoardView.svelte";

  // let object = $derived(new CoState(RoomyEntity, page.params.object));

  // const me = new AccountCoState(RoomyAccount, {
  //   resolve: {
  //     profile: {
  //       joinedSpaces: true,
  //     },
  //   },
  // });

  // let setLastRead = $state(false);

  // $effect(() => {
  //   if (setLastRead) return;

  //   let objectId = page.params.object;
  //   if (objectId && me.current?.root?.lastRead === null) {
  //     me.current.root.lastRead = LastReadList.create({});
  //   }
  //   if (objectId && me.current?.root?.lastRead) {
  //     me.current.root.lastRead[objectId] = new Date();
  //     setLastRead = true;
  //   }
  // });

  // // Migration effect for feed configs
  // $effect(() => {
  //   const objectId = page.params.object;
  //   if (objectId && object.current?.components?.feedConfig && me.current) {
  //     // Attempt to migrate old JSON config to new Jazz root structure
  //     atprotoFeedService.migrateEntityFeedConfig(
  //       me.current,
  //       objectId,
  //       object.current.components.feedConfig,
  //     );
  //   }
  // });

  let activeTab = $state("Chat") as "Chat" | "Threads";
  $effect(() => {
    if (page.url.hash == "#chat") {
      activeTab = "Chat";
    } else if (page.url.hash == "#threads") {
      activeTab = "Threads";
    } else {
      activeTab = "Chat";
    }
  });

  const query = new LiveQuery<{ name: string; channel: 1 | null }>(
    () => sql`
    select
      i.name as name,
      (select 1 from comp_channel where entity = e.ulid) as channel
      -- Add checks for other component types later, like page, feed, etc.
    from entities e
      join comp_info i on i.entity = e.ulid
    where e.ulid = ${page.params.object && Ulid.enc(page.params.object)}
  `,
  );

  const objectName = $derived(query.result?.[0]?.name || "");
  const objectType = $derived(
    query.result?.[0]?.channel == 1 ? "channel" : "unknown",
  ) as "channel" | "unknown";
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="flex items-center px-2 truncate w-full">
      <h2
        class="text-lg font-bold max-w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span class="truncate">{objectName}</span>
      </h2>
      <span class="flex-grow"></span>
      {#if objectType == "channel"}
        <Tabs
          items={[
            { name: "Chat", href: "#chat" },
            { name: "Threads", href: "#threads" },
          ]}
          active={activeTab}
        />
      {/if}
      <span class="flex-grow"></span>
    </div>
  {/snippet}

  {#if objectType == "channel"}
    {#if activeTab == "Chat"}
      <TimelineView />
    {:else if activeTab == "Threads"}
      Threads
    {/if}
  {:else if objectType == "unknown"}
    Unknown Object type
  {/if}

  <!-- 
  {#if object.current?.components?.feedConfig}
    <div class="flex-1 overflow-hidden">
      <FeedDisplay
        objectId={page.params.object ?? ""}
        singlePostUri={page.url.searchParams.get("thread") || undefined}
      />
    </div>
  {:else if object.current?.components?.[ThreadComponent.id] && activeTab == "Chat"}
    <TimelineView
      objectId={page.params.object ?? ""}
      spaceId={page.params.space ?? ""}
    />
  {:else if object.current?.components?.[ThreadComponent.id] && activeTab == "Threads"}
    <BoardView objectId={page.params.object ?? ""} />
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
  {/if} -->
</MainLayout>
