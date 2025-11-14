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
  import { page } from "$app/state";
  import TimelineView from "$lib/components/content/thread/TimelineView.svelte";
  import { current } from "$lib/queries.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import ToggleTabs from "$lib/components/layout/Tabs.svelte";
  import { Input, Modal, Popover, toast } from "@fuxui/base";
  import { Box, Button } from "@fuxui/base";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { monotonicFactory, ulid } from "ulidx";
  import { scrollContainerRef } from "$lib/utils.svelte";
  import { fade } from "svelte/transition";

  import IconHeroiconsChevronRight from "~icons/heroicons/chevron-right";
  import IconHeroiconsEllipsisHorizontal from "~icons/heroicons/ellipsis-horizontal";
  import IconHeroiconsHashtag from "~icons/heroicons/hashtag";
  import IconHeroiconsDocument from "~icons/heroicons/document";
  import IconHeroiconsChatBubbleLeftRight from "~icons/heroicons/chat-bubble-left-right";
  import ChannelBoardView from "$lib/components/content/thread/boardView/ChannelBoardView.svelte";
  import LoadingLine from "$lib/components/helper/LoadingLine.svelte";
  import type { EventType } from "$lib/workers/types";
  import PageView from "$lib/components/content/page/PageView.svelte";
  import PageHistory from "$lib/components/content/page/PageHistory.svelte";
  import { navigate } from "$lib/utils.svelte";

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  async function joinSpace() {
    try {
      const spaceId = page.params.space?.includes(".")
        ? (await backend.resolveSpaceFromHandleOrDid(page.params.space))
            ?.spaceId
        : page.params.space;
      if (!spaceId || !backendStatus.personalStreamId) {
        toast.error("Could not join space. It's possible it does not exist.");
        return;
      }
      await backend.sendEvent(backendStatus.personalStreamId, {
        ulid: ulid(),
        parent: undefined,
        variant: {
          kind: "space.roomy.space.join.0",
          data: {
            spaceId,
          },
        },
      });
    } catch (e) {
      console.error(e);
      toast.error("Could not join space. It's possible it does not exist.");
    }
  }

  const ref = $derived($scrollContainerRef);
  let shouldShowPageTitle = $state(false);

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

  let createPageDialogOpen = $state(false);
  let createPageName = $state("");
  async function createPage() {
    const pageName = createPageName;
    const ulid = monotonicFactory();
    if (!current.space || !object) return;

    promoteChannelDialogOpen = false;

    const events: EventType[] = [];

    // Create a new room for the page
    const pageId = ulid();
    events.push({
      ulid: pageId,
      parent: page.params.object,
      variant: {
        kind: "space.roomy.room.create.0",
        data: undefined,
      },
    });

    // Mark the room as a page
    events.push({
      ulid: ulid(),
      parent: pageId,
      variant: {
        kind: "space.roomy.page.mark.0",
        data: undefined,
      },
    });

    // Set the page name
    events.push({
      ulid: ulid(),
      parent: pageId,
      variant: {
        kind: "space.roomy.info.0",
        data: {
          name: { set: pageName },
          avatar: { ignore: undefined },
          description: { ignore: undefined },
        },
      },
    });

    events.push({
      ulid: ulid(),
      parent: pageId,
      variant: {
        kind: "space.roomy.page.edit.0",
        data: {
          content: {
            content: new TextEncoder().encode(
              `# ${pageName}\n\nNew page. Fill me with something awesome. ✨`,
            ),
            mimeType: "text/markdown",
          },
        },
      },
    });

    try {
      await backend.sendEventBatch(current.space.id, events);
      toast.success(`Created page: ${pageName}`);
      navigate({ space: current.space.id, object: pageId });
    } catch (e) {
      toast.error(`Error creating page: ${e}`);
    } finally {
      createPageDialogOpen = false;
    }
  }

  let promoteChannelName = $state("");
  $effect(() => {
    promoteChannelName = object?.name || "";
  });
  let promoteChannelDialogOpen = $state(false);
  async function promoteToChannel() {
    const channelName = promoteChannelName;
    const ulid = monotonicFactory();
    if (!current.space || !object) return;

    // Unmark the thread as a thread
    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: page.params.object,
      variant: {
        kind: "space.roomy.thread.unmark.0",
        data: undefined,
      },
    });

    // Mark the thread as a channel
    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: page.params.object,
      variant: {
        kind: "space.roomy.channel.mark.0",
        data: undefined,
      },
    });

    // Make the thread a sibling of it's parent channel
    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: page.params.object,
      variant: {
        kind: "space.roomy.parent.update.0",
        data: {
          parent: object.parent?.parent || undefined,
        },
      },
    });

    // If a new name was specified
    if (channelName != object.name) {
      // Rename it
      await backend.sendEvent(current.space.id, {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.info.0",
          data: {
            name: { set: channelName },
            avatar: { ignore: undefined },
            description: { ignore: undefined },
          },
        },
      });
    }

    promoteChannelDialogOpen = false;
  }

  async function convertToThread() {
    if (!current.space || !object) return;

    const ulid = monotonicFactory();
    const events: EventType[] = [
      {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.channel.unmark.0",
          data: undefined,
        },
      },
      {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.thread.mark.0",
          data: undefined,
        },
      },
    ];
    await backend.sendEventBatch(current.space.id, events);
  }
  async function convertToPage() {
    if (!current.space || !object) return;

    const ulid = monotonicFactory();
    const events: EventType[] = [
      {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.channel.unmark.0",
          data: undefined,
        },
      },
      {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.page.mark.0",
          data: undefined,
        },
      },
      {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.page.edit.0",
          data: {
            content: {
              content: new TextEncoder().encode(
                `# ${object.name}\n\nConverted channel to page.`,
              ),
              mimeType: "text/markdown",
            },
          },
        },
      },
    ];
    await backend.sendEventBatch(current.space.id, events);
  }

  const channelTabList = ["Chat", "Threads", "Pages"] as const;
  let channelActiveTab = $state("Chat") as (typeof channelTabList)[number];
  $effect(() => {
    if (page.url.hash == "#chat") {
      channelActiveTab = "Chat";
    } else if (page.url.hash == "#threads") {
      channelActiveTab = "Threads";
    } else if (page.url.hash == "#pages") {
      channelActiveTab = "Pages";
    } else {
      channelActiveTab = "Chat";
    }
  });

  const pageTabList = ["Page", "History"] as const;
  let pageActiveTab = $state("Page") as (typeof pageTabList)[number];
  $effect(() => {
    if (page.url.hash == "#history") {
      pageActiveTab = "History";
    } else {
      pageActiveTab = "Page";
    }
  });

  const objectQuery = new LiveQuery<{
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
          'id', id(pe.id),
          'name', pi.name,
          'kind', pr.label,
          'parent', id(pe.parent)
        )
        from comp_info pi
          join entities pe on pe.id = pi.entity
          join comp_room pr on pe.id = pr.entity
          where pe.id = e.parent
      ),
      'kind', r.label,
      'lastRead', coalesce(l.timestamp, 1)
    ) as json
    from entities e
      join comp_info i on i.entity = e.id
      join comp_room r on r.entity = e.id
      left join comp_last_read l on l.entity = e.id
    where e.id = ${page.params.object && id(page.params.object)}
  `,
    (row) => JSON.parse(row.json),
  );
  const object = $derived(objectQuery.result?.[0]);

  $effect(() => {
    object;
  });

  let sentLastReadMarker = $state(false); // flag to ensure lastRead event is only sent once per page load

  $effect(() => {
    page.params.object;
    // User navigated to a new page
    sentLastReadMarker = false;
    return () => {
      // Also send the marker when navigating away
      setPageReadMarker();
    };
  });

  async function setPageReadMarker() {
    if (
      !backendStatus.personalStreamId ||
      !page.params.space ||
      !page.params.object ||
      sentLastReadMarker === true
    )
      return;
    sentLastReadMarker = true;
    await backend.sendEvent(backendStatus.personalStreamId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.lastRead.0",
        data: {
          streamId: page.params.space,
          roomId: page.params.object,
        },
      },
    });
  }

  $effect(() => {
    if (
      !backendStatus.personalStreamId ||
      !page.params.space ||
      !page.params.object ||
      !object?.lastRead
    )
      return;
    backend.runQuery(
      sql`update comp_last_read set unread_count = 0 where entity = ${id(page.params.object)}`,
    );
    const elapsed = Date.now() - object.lastRead;
    if (elapsed < 1000 * 60 * 5) return;
    setTimeout(setPageReadMarker, 1000);
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="relative w-full">
      <div class="flex items-center w-full max-w-full">
        <h2
          class="mr-2 max-w-full truncate font-regular shrink py-4 text-base-900 dark:text-base-100 flex items-center gap-2 transition-all duration-300"
        >
          {#if object?.kind === "channel" || object?.kind === "thread"}
            <div>
              <IconHeroiconsHashtag
                class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300"
              />
            </div>
          {/if}

          {#if object?.kind === "page" && shouldShowPageTitle}
            <div in:fade={{ duration: 300 }} out:fade={{ duration: 100 }}>
              <IconHeroiconsDocument
                class="w-5 h-5 ml-2 shrink-0 text-base-700 dark:text-base-300 mr-1"
              />
            </div>
          {/if}

          {#if object?.parent && object.parent.kind == "channel" && (object?.kind !== "page" || shouldShowPageTitle)}
            <a
              href={`/${page.params.space}/${object.parent.id}${object.kind == "page" ? "#pages" : object.kind == "thread" ? "#threads" : ""}`}
              class="hover:underline underline-offset-4"
            >
              {object?.parent?.name}
            </a>
            <IconHeroiconsChevronRight class="w-4 h-4 shrink-0" />
          {/if}

          {#if object?.kind !== "page"}
            <span class="truncate">{object?.name}</span>
          {:else if shouldShowPageTitle}
            <span
              class="truncate"
              in:fade={{ duration: 300 }}
              out:fade={{ duration: 100 }}>{object?.name}</span
            >
          {/if}
        </h2>
        <div class="flex items-center ml-auto shrink-0 gap-2">
          {#if current.space?.id && backendStatus.loadingSpaces}
            <div class="dark:!text-base-400 !text-base-600 mx-3">
              Downloading Entire Space...
            </div>
          {:else if object?.kind == "thread"}
            <Popover>
              {#snippet child({ props })}
                <Button {...props}>
                  <span class="hidden md:block">Thread Options</span>
                  <IconHeroiconsEllipsisHorizontal
                    class="shrink-0 block md:hidden"
                  /></Button
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
                onsubmit={promoteToChannel}
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
          {:else if object?.kind == "channel"}
            <ToggleTabs
              items={channelTabList.map((x) => ({
                name: x,
                href: `#${x.toLowerCase()}`,
              }))}
              active={channelActiveTab}
            />
            <Button
              class="hidden lg:block"
              onclick={() => (createPageDialogOpen = true)}>Create Page</Button
            >

            <Popover>
              {#snippet child({ props })}
                <Button {...props}
                  ><span class="hidden lg:block">Channel Options</span
                  ><IconHeroiconsEllipsisHorizontal
                    class="shrink-0 block lg:hidden"
                  />
                </Button>
              {/snippet}

              <div class="flex flex-col gap-2">
                <Button
                  class="block lg:hidden"
                  onclick={() => (createPageDialogOpen = true)}
                  >Create Page</Button
                >
                <Button onclick={convertToThread}>Convert to Thread</Button>
                <Button onclick={convertToPage}>Convert to Page</Button>
              </div>
            </Popover>

            <Modal bind:open={createPageDialogOpen} title="Create Page">
              <form
                class="flex flex-col items-stretch gap-4"
                onsubmit={createPage}
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
          {:else if object?.kind == "page"}
            {#if pageActiveTab == "Page"}
              <Button
                data-active={showPageChat}
                variant={showPageChat ? "primary" : "secondary"}
                onclick={() => toggleShowPageChat()}
                ><IconHeroiconsChatBubbleLeftRight
                  class="shrink-0"
                />Chat</Button
              >
            {/if}
            <ToggleTabs
              items={pageTabList.map((x) => ({
                name: x,
                href: `#${x.toLowerCase()}`,
              }))}
              active={pageActiveTab}
            />
          {/if}
        </div>
      </div>

      {#if current.space?.id && backendStatus.loadingSpaces}
        <LoadingLine />
      {/if}
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
    {#if channelActiveTab == "Chat"}
      <TimelineView />
    {:else if channelActiveTab == "Threads"}
      <ChannelBoardView />
    {:else if channelActiveTab == "Pages"}
      <ChannelBoardView objectType={"page"} />
    {/if}
  {:else if object?.kind == "thread"}
    <TimelineView />
  {:else if object?.kind == "page"}
    {#if pageActiveTab == "Page"}
      <PageView bind:showPageChat />
    {:else}
      <PageHistory />
    {/if}
  {:else}
    <div class="p-4">Unknown Object type</div>
  {/if}
</MainLayout>
