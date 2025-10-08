<script lang="ts">
  import { page } from "$app/state";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  import { current } from "$lib/queries.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import BoardView from "$lib/components/content/thread/boardView/BoardView.svelte";
  // import PageView from "$lib/components/content/page/PageView.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import { Tabs } from "@fuxui/base";
  import { Box, Button } from "@fuxui/base";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { ulid } from "ulidx";

  import IconMdiArrowRight from "~icons/mdi/arrow-right";

  // import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  // import FeedDisplay from "$lib/components/content/bluesky-feed/FeedDisplay.svelte";
  // import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  // import BoardView from "$lib/components/content/thread/BoardView.svelte";

  // let object = $derived(new CoState(RoomyEntity, page.params.object));

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  // // fetch first 100 events
  // async function fetchEvents() {
  //   if (!backendStatus.personalStreamId || !page.params.space) return;
  //   console.log("Fetching events for space", page.params.space);
  //   await backend.previewSpace(page.params.space);
  //   console.log("Space preview materialised");
  // }

  // fetchEvents();

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

  const query = new LiveQuery<{
    name: string;
    kind: string;
    parent?: { id: string; name: string; kind: string };
  }>(
    () => sql`
    select json_object(
      'name', name,
      'parent', (
        select json_object(
          'id', id(pe.id),
          'name', pi.name,
          'kind', pr.label
        )
        from comp_info pi
          join entities pe on pe.id = pi.entity
          join comp_room pr on pe.id = pr.entity
          where pe.id = e.parent
      ),
      'kind', r.label
    ) as json
    from entities e
      join comp_info i on i.entity = e.id
      join comp_room r on r.entity = e.id
    where e.id = ${page.params.object && id(page.params.object)}
  `,
    (row) => JSON.parse(row.json),
  );
  const object = $derived(query.result?.[0]);
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
        {#if object?.parent && object.parent.kind == "channel"}
          <a
            href={`/${page.params.space}/${object.parent.id}`}
            class="hover:underline underline-offset-4"
          >
            {object?.parent?.name}
          </a>
          <IconMdiArrowRight />
        {/if}
        <span class="truncate">{object?.name}</span>
      </h2>
      <span class="flex-grow"></span>
      {#if object?.kind == "channel"}
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
  {:else if object?.kind == "channel"}
    {#if activeTab == "Chat"}
      <TimelineView />
    {:else if activeTab == "Threads"}
      <BoardView />
    {/if}
  {:else if object?.kind == "thread"}
    <TimelineView />
  {:else}
    <div class="p-4">Unknown Object type</div>
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
