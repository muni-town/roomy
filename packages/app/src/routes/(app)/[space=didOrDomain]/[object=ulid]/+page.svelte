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
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer, peerStatus } from "$lib/workers";

  import {
    // convertToPage,
    // convertToThread,
    createPage,
    setPageReadMarker,
  } from "$lib/mutations/room";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { navigate, scrollContainerRef } from "$lib/utils.svelte";

  import { Modal, Popover, toast } from "@foxui/core";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import ToggleTabs from "@roomy/design/components/layout/ToggleTabs.svelte";
  import ChannelBoardView from "$lib/components/content/thread/boardView/ChannelBoardView.svelte";
  import LoadingLine from "@roomy/design/components/helper/LoadingLine.svelte";
  import PageView from "$lib/components/content/page/PageView.svelte";
  import PageHistory from "$lib/components/content/page/PageHistory.svelte";
  import JoinSpaceModal from "$lib/components/modals/JoinSpaceModal.svelte";

  import {
    IconHashtag,
    IconDocument,
    IconChatBubble,
    IconBars,
  } from "@roomy/design/icons";

  import Error from "@roomy/design/components/modals/Error.svelte";

  import { flags } from "$lib/config";
  import { deleteRoom, newUlid, Ulid } from "@roomy-space/sdk";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import { goto } from "$app/navigation";
  // import EditRoomModal from "$lib/components/modals/EditRoomModal.svelte";

  let loading = $state(false);
  let deleteThreadDialogOpen = $state(false);
  let createPageDialogOpen = $state(false);
  let createPageName = $state("");
  let promoteChannelName = $state("");
  let parentRoomId = $derived(page.url.searchParams.get("parent"));

  const channelTabList = ["Chat", "Threads"] as const;
  let channelActiveTab = $state<(typeof channelTabList)[number]>("Chat");

  const pageTabList = ["Page", "History"] as const;
  let pageActiveTab = $state<(typeof pageTabList)[number]>("Page");

  let shouldShowPageTitle = $state(false);
  let promoteChannelDialogOpen = $state(false);
  let sentLastReadMarker = $state(false); // flag to ensure lastRead event is only sent once per page load

  // let editRoomModalOpen = $state(false);

  const roomQuery = new LiveQuery<{
    name: string;
    kind: string;
    spaceId: string;
    lastRead: number;
    unreadCount: number;
  }>(
    () => sql`
    select json_object(
      'name', name,
      'kind', r.label,
      'spaceId', e.stream_id,
      'lastRead', coalesce(l.last_read, 0),
      'unreadCount', coalesce(l.unread_count, 0)
    ) as json
    from entities e
      join comp_info i on i.entity = e.id
      join comp_room r on r.entity = e.id
      left join comp_last_read l on l.entity = e.id
    where e.id = ${app.roomId}
  `,
    (row) => JSON.parse(row.json),
    {
      description: "Room: name, kind, spaceId, lastRead and unreadCount",
      origin: "routes/(app)/space/object/+page.svelte",
    },
  );
  const room = $derived(roomQuery.result?.[0]);
  const ref = $derived($scrollContainerRef);
  const spaceId = $derived(app.joinedSpace?.id);

  const setPageRead = () => {
    if (
      peerStatus.roomyState?.state !== "connected" ||
      !spaceId ||
      !page.params.object ||
      sentLastReadMarker === true
    )
      return;
    sentLastReadMarker = true;
    setPageReadMarker({
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
    if (!room) return;
    // If the room's spaceId doesn't match the URL, navigate to space root
    if (app.space.status == "joined" && app.space.space.id !== room.spaceId) {
      navigate({
        space: page.params.space,
      });
    }
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
      !peerStatus.authState ||
      peerStatus.authState.state !== "authenticated" ||
      !page.params.space ||
      !page.params.object ||
      room == null ||
      room.unreadCount === 0
    )
      return;
    // Clear unread count locally. Tracks unreadCount as a reactive dependency
    // so this re-fires after lazyLoadRoom materializes historical messages and
    // re-increments the count. The server-side markRead is sent on navigate-away.
    peer.runQuery(
      sql`update comp_last_read set unread_count = 0 where entity = ${page.params.object}`,
    );
  });

  async function deleteThread() {
    if (!page.params.object || !spaceId) return;

    loading = true;
    try {
      const events = deleteRoom({ roomId: Ulid.assert(page.params.object) });
      if (parentRoomId) {
        events.push({
          $type: "space.roomy.link.removeRoomLink.v0",
          id: newUlid(),
          room: Ulid.assert(parentRoomId),
          linkToRoom: Ulid.assert(page.params.object),
        });
      }
      await peer.sendEventBatch(spaceId, events);

      toast.success("Successfully deleted stream");

      await goto(`/${page.params.space}`);
    } catch (e) {
      console.error(e);
      toast.error(`Error deleting thread: ${e}`);
    } finally {
      loading = false;
      deleteThreadDialogOpen = false;
    }
  }
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

{#snippet navbar()}
  <div class="relative w-full">
    {#if room?.kind == "space.roomy.channel"}
      <div class="grid grid-cols-3 items-center w-full">
        <!-- Left: channel name -->
        <h2 class="flex items-center gap-2 min-w-0">
          <IconHashtag
            class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300"
          />
          <span class="truncate max-w-[45ch] text-base-900 dark:text-base-100"
            >{room?.name}</span
          >
        </h2>

        <!-- Center: tabs -->
        {#if flags.threadsList}
          <div class="flex justify-center">
            <ToggleTabs
              items={channelTabList.map((x) => ({
                name: x,
                href: `#${x.toLowerCase()}`,
              }))}
              active={channelActiveTab}
            />
          </div>
        {/if}

        <!-- Right: button -->
        <div class="flex justify-end">
          <Button variant="secondary" size="icon">
            <IconBars />
          </Button>
        </div>
      </div>
    {:else if room?.kind == "space.roomy.thread"}
      <div class="flex items-center gap-2 w-full max-w-full pr-2">
        <h2
          class="mr-2 truncate font-regular py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
        >
          <IconHashtag
            class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300"
          />
          <span class="truncate">{room?.name}</span>
        </h2>

        <span class="grow"></span>

        {#if app.isSpaceAdmin}
          <Popover>
            {#snippet child({ props })}
              <Button {...props} variant="secondary" size="icon">
                <IconBars class="shrink-0" />
              </Button>
            {/snippet}
            <Button onclick={() => (deleteThreadDialogOpen = true)}>
              Delete Thread
            </Button>
          </Popover>
        {/if}

        <Modal bind:open={deleteThreadDialogOpen}>
          <form
            class="flex flex-col items-stretch gap-4"
            onsubmit={deleteThread}
          >
            Are you Sure you want to delete this thread?
            <div class="flex justify-end">
              <Button type="submit" disabled={loading}>
                {#if loading}<LoadingSpinner />{/if} Delete
              </Button>
            </div>
          </form>
        </Modal>

        <Modal bind:open={promoteChannelDialogOpen}>
          <form
            class="flex flex-col items-stretch gap-4"
            onsubmit={async () => {
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
      </div>
    {:else if room?.kind == "space.roomy.page"}
      <div class="flex items-center gap-2 w-full max-w-full pr-2">
        <h2
          class="mr-2 truncate font-regular py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
        >
          {#if shouldShowPageTitle}
            <div in:fade={{ duration: 300 }} out:fade={{ duration: 100 }}>
              <IconDocument
                class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300 mr-1"
              />
            </div>
            <div class="grow w-full">
              <span
                class="truncate"
                in:fade={{ duration: 300 }}
                out:fade={{ duration: 100 }}>{room?.name}</span
              >
            </div>
          {/if}
        </h2>

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
          >
            <IconChatBubble class="shrink-0" />Chat
          </Button>
        {/if}
      </div>
    {/if}

    {#if spaceId && peerStatus.authState?.state === "loading"}
      <LoadingLine />
    {/if}
  </div>
{/snippet}

{#if app.space.status === "error"}
  <MainLayout>
    <Error message={app.space.message} goHome />
  </MainLayout>
{:else if app.space.status === "invited"}
  <MainLayout>
    <JoinSpaceModal />
  </MainLayout>
{:else}
  <MainLayout {sidebar} {navbar} chatArea>
    {#if app.space.status === "loading"}
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
    {/if}
  </MainLayout>
{/if}

<!-- <EditRoomModal bind:open={editRoomModalOpen} /> -->
