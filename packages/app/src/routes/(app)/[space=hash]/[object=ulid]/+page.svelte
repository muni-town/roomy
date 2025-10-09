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
  import { Input, Modal, Popover, Tabs } from "@fuxui/base";
  import { Box, Button } from "@fuxui/base";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { monotonicFactory, ulid } from "ulidx";

  import IconMdiArrowRight from "~icons/mdi/arrow-right";
  import ChannelBoardView from "$lib/components/content/thread/boardView/ChannelBoardView.svelte";

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

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

  let promoteChannelName = $state("");
  $effect(() => {
    promoteChannelName = object?.name || "";
  });
  let promoteChannelDialogOpen = $state(false);
  async function promoteToChannel() {
    const channelName = promoteChannelName;
    const ulid = monotonicFactory();
    if (!current.space || !page.params.space || !object) return;

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
    parent?: { id: string; name: string; kind: string; parent: string | null };
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

      {#if object?.kind == "thread"}
        <Popover>
          {#snippet child({ props })}
            <Button {...props}>Thread Options</Button>
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
    {#if activeTab == "Chat"}
      <TimelineView />
    {:else if activeTab == "Threads"}
      <ChannelBoardView />
    {/if}
  {:else if object?.kind == "thread"}
    <TimelineView />
  {:else}
    <div class="p-4">Unknown Object type</div>
  {/if}
</MainLayout>
