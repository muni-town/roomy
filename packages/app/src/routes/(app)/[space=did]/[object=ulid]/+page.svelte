<script lang="ts" module>
  let showPageChat = $state(false);
  export function toggleShowPageChat() {
    showPageChat = !showPageChat;
  }
  export function ensureShowPageChat() {
    if (!showPageChat) {
      showPageChat = true;
    }
  }
</script>

<script lang="ts">
  import { fade } from "svelte/transition";

  import { page } from "$app/state";
  import { current } from "$lib/queries";
  import { backend, backendStatus } from "$lib/workers";

  import {
    convertToPage,
    convertToThread,
    createPage,
    setPageReadMarker,
  } from "$lib/mutations/room";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { navigate, scrollContainerRef } from "$lib/utils.svelte";

  import { Input, Modal, Popover, Button, toast } from "@fuxui/base";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import ToggleTabs from "$lib/components/layout/ToggleTabs.svelte";
  import ChannelBoardView from "$lib/components/content/thread/boardView/ChannelBoardView.svelte";
  import LoadingLine from "$lib/components/helper/LoadingLine.svelte";
  import PageView from "$lib/components/content/page/PageView.svelte";
  import PageHistory from "$lib/components/content/page/PageHistory.svelte";
  import JoinSpaceModal from "$lib/components/modals/JoinSpaceModal.svelte";

  import IconHeroiconsChevronRight from "~icons/heroicons/chevron-right";
  import IconHeroiconsHashtag from "~icons/heroicons/hashtag";
  import IconHeroiconsDocument from "~icons/heroicons/document";
  import IconHeroiconsChatBubbleLeftRight from "~icons/heroicons/chat-bubble-left-right";
  import IconTablerClick from "~icons/tabler/click";
  import IconTablerSettings from "~icons/tabler/settings";

  import Error from "$lib/components/modals/Error.svelte";
  import { Ulid } from "$lib/schema";
  import { flags } from "$lib/flags";
  import EditRoomModal from "$lib/components/modals/EditRoomModal.svelte";

  let createPageDialogOpen = $state(false);
  let createPageName = $state("");
  let promoteChannelName = $state("");

  const channelTabList = ["Chat", "Threads"] as const;
  let channelActiveTab = $state<(typeof channelTabList)[number]>("Chat");

  const pageTabList = ["Page", "History"] as const;
  let pageActiveTab = $state<(typeof pageTabList)[number]>("Page");

  let shouldShowPageTitle = $state(false);
  let promoteChannelDialogOpen = $state(false);
  let sentLastReadMarker = $state(false); // flag to ensure lastRead event is only sent once per page load

  let editRoomModalOpen = $state(false);

  const roomQuery = new LiveQuery<{
    name: string;
    kind: string;
    parent?: { id: string; name: string; kind: string; parent: string | null };
    lastRead: number;
  }>(
    () => sql`
    select json_object(
      'name', name,
      'parent', (
        select json_object(
          'id', pe.id,
          'name', pi.name,
          'kind', pr.label,
          'parent', pe.room
        )
        from comp_info pi
          join entities pe on pe.id = pi.entity
          join comp_room pr on pe.id = pr.entity
          where pe.id = e.room
      ),
      'kind', r.label,
      'lastRead', coalesce(l.timestamp, 1)
    ) as json
    from entities e
      join comp_info i on i.entity = e.id
      join comp_room r on r.entity = e.id
      left join comp_last_read l on l.entity = e.id
    where e.id = ${page.params.object}
  `,
    (row) => JSON.parse(row.json),
  );
  const room = $derived(roomQuery.result?.[0]);
  const ref = $derived($scrollContainerRef);
  const spaceId = $derived(current.joinedSpace?.id);

  const setPageRead = () => {
    if (
      !backendStatus.authState ||
      backendStatus.authState.state !== "authenticated" ||
      !spaceId ||
      !page.params.object ||
      sentLastReadMarker === true
    )
      return;
    sentLastReadMarker = true;
    setPageReadMarker({
      personalStreamId: backendStatus.authState.personalStream,
      streamId: spaceId,
      roomId: Ulid.assert(page.params.object),
    });
  };

  $effect(() => {
    if (!ref) return;

    function handleScroll() {
      if (ref && ref.scrollTop > 100) {
        shouldShowPageTitle = true;
      } else {
        shouldShowPageTitle = false;
      }
    }

    ref.addEventListener("scroll", handleScroll);
    return () => ref.removeEventListener("scroll", handleScroll);
  });

  $effect(() => {
    promoteChannelName = room?.name || "";
  });

  $effect(() => {
    if (page.url.hash == "#chat") {
      channelActiveTab = "Chat";
    } else if (page.url.hash == "#threads") {
      channelActiveTab = "Threads";
    } else {
      channelActiveTab = "Chat";
    }
  });

  $effect(() => {
    if (page.url.hash == "#history") {
      pageActiveTab = "History";
    } else {
      pageActiveTab = "Page";
    }
  });

  $effect(() => {
    room;
  });

  $effect(() => {
    page.params.object;
    // User navigated to a new page
    sentLastReadMarker = false;
    return () => {
      // Also send the marker when navigating away
      setPageRead();
    };
  });

  $effect(() => {
    if (
      !backendStatus.authState ||
      backendStatus.authState.state !== "authenticated" ||
      !page.params.space ||
      !page.params.object ||
      !room?.lastRead
    )
      return;
    backend.runQuery(
      sql`update comp_last_read set unread_count = 0 where entity = ${page.params.object}`,
    );
    const elapsed = Date.now() - room.lastRead;
    if (elapsed < 1000 * 60 * 5) return;
    setTimeout(setPageRead, 1000);
  });

  $effect(() => {
    if (!current.joinedSpace?.id || !current.roomId) return;
    backend.lazyLoadRoom(current.joinedSpace.id, current.roomId);
  });
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

{#snippet navbar()}
  <div class="relative w-full">
    <div class="flex items-center gap-2 w-full max-w-full">
      <h2
        class="mr-2 w-full max-w-full truncate font-regular py-4 text-base-900 dark:text-base-100 flex items-center gap-2 transition-all duration-300"
      >
        {#if room?.kind === "space.roomy.channel" || room?.kind === "space.roomy.thread"}
          <div>
            <IconHeroiconsHashtag
              class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300"
            />
          </div>
        {/if}

        {#if room?.kind === "space.roomy.page" && shouldShowPageTitle}
          <div in:fade={{ duration: 300 }} out:fade={{ duration: 100 }}>
            <IconHeroiconsDocument
              class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300 mr-1"
            />
          </div>
        {/if}

        {#if room?.parent && room.parent.kind == "space.roomy.channel" && (room?.kind !== "space.roomy.page" || shouldShowPageTitle)}
          <a
            href={`/${page.params.space}/${room.parent.id}${room.kind == "space.roomy.page" ? "#pages" : room.kind == "space.roomy.thread" ? "#threads" : ""}`}
            class="hover:underline underline-offset-4"
          >
            {room?.parent?.name}
          </a>
          <IconHeroiconsChevronRight class="w-4 h-4 shrink-0" />
        {/if}

        {#if room?.kind !== "space.roomy.page"}
          <span class="truncate">{room?.name}</span>
        {:else if shouldShowPageTitle}
          <div class="grow w-full">
            <span
              class="truncate"
              in:fade={{ duration: 300 }}
              out:fade={{ duration: 100 }}>{room?.name}</span
            >
          </div>
        {/if}
      </h2>

      {#if spaceId && backendStatus.authState?.state === "loading"}
        <div class="dark:!text-base-400 !text-base-600 mx-3">
          Downloading Entire Space...
        </div>
      {:else if room?.kind == "space.roomy.thread"}
        <span class="grow"></span>

        <Popover>
          {#snippet child({ props })}
            <Button {...props} variant="secondary" size="icon">
              <IconTablerClick class="shrink-0" /></Button
            >
          {/snippet}

          <Button onclick={() => (promoteChannelDialogOpen = true)}
            >Promote to Channel</Button
          >
        </Popover>

        <Modal
          bind:open={promoteChannelDialogOpen}
          title="Promote Thread to Channel"
        >
          <form
            class="flex flex-col items-stretch gap-4"
            onsubmit={async () => {
              // await addRoomToSidebar({
              //   spaceId: spaceId!,
              //   room: {
              //     id: Ulid.assert(page.params.object),
              //     name: room.name,
              //     parent: room.parent,
              //   },
              //   channelName: promoteChannelName,
              // });
              promoteChannelDialogOpen = false;
            }}
          >
            <label class="flex flex-col gap-2">
              New Channel Name
              <Input bind:value={promoteChannelName} />
            </label>

            <div class="flex justify-end">
              <Button type="submit">Promote</Button>
            </div>
          </form>
        </Modal>
      {:else if room?.kind == "space.roomy.channel"}
        <span class="grow"></span>

        {#if flags.threadsList}
          <ToggleTabs
            items={channelTabList.map((x) => ({
              name: x,
              href: `#${x.toLowerCase()}`,
            }))}
            active={channelActiveTab}
          />
        {/if}

        <div class="grow w-1/2"></div>

        <Popover>
          {#snippet child({ props })}
            <Button {...props} variant="secondary" size="icon">
              <IconTablerClick class="shrink-0" />
            </Button>
          {/snippet}

          <div class="flex flex-col gap-2">
            <Button onclick={() => (createPageDialogOpen = true)}
              >Create Page</Button
            >
            <Button
              onclick={async () => {
                if (!spaceId) return;
                await convertToThread({
                  spaceId,
                  roomId: Ulid.assert(page.params.object),
                });
              }}>Convert to Thread</Button
            >
            <Button
              onclick={async () => {
                if (!spaceId) return;
                await convertToPage({
                  spaceId,
                  room: {
                    id: Ulid.assert(page.params.object),
                    name: room.name,
                  },
                });
              }}>Convert to Page</Button
            >
          </div>
        </Popover>

        {#if current.isSpaceAdmin}
          <Button
            variant="secondary"
            size="icon"
            onclick={() => (editRoomModalOpen = true)}
          >
            <IconTablerSettings class="shrink-0" /></Button
          >
        {/if}

        <Modal bind:open={createPageDialogOpen} title="Create Page">
          <form
            class="flex flex-col items-stretch gap-4"
            onsubmit={async () => {
              promoteChannelDialogOpen = false;
              try {
                const roomId = page.params.object;
                const pageId = await createPage({
                  spaceId: spaceId!,
                  parentRoomId: Ulid.assert(roomId),
                  pageName: createPageName,
                });
                toast.success(`Created page: ${createPageName}`);
                navigate({ space: spaceId, object: pageId });
              } catch (e) {
                toast.error(`Error creating page: ${e}`);
              } finally {
                createPageDialogOpen = false;
              }
            }}
          >
            <label class="flex flex-col gap-2">
              Page Name
              <Input bind:value={createPageName} />
            </label>

            <div class="flex justify-end">
              <Button type="submit">Create</Button>
            </div>
          </form>
        </Modal>
      {:else if room?.kind == "space.roomy.page"}
        <span class="grow"></span>
        <ToggleTabs
          items={pageTabList.map((x) => ({
            name: x,
            href: `#${x.toLowerCase()}`,
          }))}
          active={pageActiveTab}
        />
        <span class="grow w-2/3"></span>

        {#if pageActiveTab == "Page"}
          <Button
            data-active={showPageChat}
            variant={showPageChat ? "primary" : "secondary"}
            onclick={() => toggleShowPageChat()}
            ><IconHeroiconsChatBubbleLeftRight class="shrink-0" />Chat</Button
          >
        {/if}
      {/if}
    </div>
  </div>

  {#if spaceId && backendStatus.authState?.state === "loading"}
    <LoadingLine />
  {/if}
{/snippet}

{#if current.space.status === "error"}
  <MainLayout>
    <Error message={current.space.message} />
  </MainLayout>
{:else if current.space.status === "invited"}
  <MainLayout>
    <JoinSpaceModal />
  </MainLayout>
{:else}
  <MainLayout {sidebar} {navbar}>
    {#if current.space.status === "loading"}
      <!-- TODO loading spinner -->
      <div class="h-full w-full flex">
        <div class="m-auto">Loading...</div>
      </div>
    {:else if room?.kind == "space.roomy.channel"}
      {#if channelActiveTab == "Chat"}
        <TimelineView />
      {:else if channelActiveTab == "Threads"}
        <ChannelBoardView />
      {/if}
    {:else if room?.kind == "space.roomy.thread"}
      <TimelineView />
    {:else if room?.kind == "space.roomy.page"}
      {#if pageActiveTab == "Page"}
        <PageView bind:showPageChat />
      {:else}
        <PageHistory />
      {/if}
    {:else}
      <div class="p-4">Unknown Object type</div>
    {/if}
  </MainLayout>
{/if}

<EditRoomModal bind:open={editRoomModalOpen} />
