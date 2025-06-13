<script lang="ts">
  import { page } from "$app/state";
  import type { Channel, RoomyAccount, Space } from "$lib/jazz/schema";
  import { isSpaceAdmin, publicGroup } from "$lib/jazz/utils";
  import { navigate, navigateSync } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Button } from "@fuxui/base";
  import { co, z } from "jazz-tools";

  let {
    channel,
    deleteItem,
    space,
    lastReadDate,
    me,
  }: {
    channel: co.loaded<typeof Channel> | undefined | null;
    deleteItem: (channel: co.loaded<typeof Channel>) => void;
    space: co.loaded<typeof Space> | undefined | null;
    lastReadDate: Date | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  const latestEntriesByAccount = $derived(
    Object.values(channel?.mainThread?.timeline?.perAccount ?? {}).sort(
      (a, b) => a.madeAt.getTime() - b.madeAt.getTime(),
    ),
  );

  let isNew = $derived.by(() => {
    if (!lastReadDate) return latestEntriesByAccount.length !== 0;
    if (latestEntriesByAccount.length === 0) return false;
    let date = latestEntriesByAccount.at(-1)?.madeAt;
    if (!date) return false;

    return new Date(lastReadDate) < date;
  });

  const channelNotifications = $derived(
    me?.profile?.roomyInbox?.filter(
      (x) => x?.channelId === channel?.id && !x?.read,
    ).length,
  );

  const channelThreads = $derived.by(() => {
    if (!me?.id || !channel?.subThreads) return [];

    return channel.subThreads.filter((thread) => {
      if (!thread || thread.softDeleted) return false;
      
      // Check if explicitly unsubscribed
      try {
        const isUnsubscribed = me?.profile?.threadSubscriptions?.some?.(subId => subId === `unsubscribe:${thread.id}`);
        if (isUnsubscribed) return false;
      } catch (e) {
        // Ignore subscription check errors to prevent breaking the channel list
      }
      
      // Check if I created the thread
      if (thread._edits?.name?.by?.id === me.id) return true;

      // Check if I sent any messages in this thread
      const threadTimeline = thread.timeline;
      if (!threadTimeline?.perAccount) return false;

      const myMessages = threadTimeline.perAccount[me.id];
      if (myMessages && myMessages.length > 0) return true;

      // Also check all timeline entries for my account ID
      const allEntries = Object.values(threadTimeline.perAccount);
      for (const accountEntries of allEntries) {
        if (accountEntries.by?.id === me.id) return true;
      }

      return false;
    });
  });

  function unsubscribeFromThread(threadId: string) {
    try {
      if (!me?.profile) return;
      
      if (!me.profile.threadSubscriptions) {
        me.profile.threadSubscriptions = co.list(z.string()).create([], publicGroup("writer"));
      }
      me.profile.threadSubscriptions.push(`unsubscribe:${threadId}`);
    } catch (e) {
      console.error('Failed to unsubscribe from thread:', e);
    }
  }

  const threadNotifications = $derived.by(() => {
    if (!channelThreads) return 0;
    return channelThreads.reduce((total, thread) => {
      const threadNotifs =
        me?.profile?.roomyInbox?.filter(
          (x) => x?.threadId === thread?.id && !x?.read,
        ).length || 0;
      return total + threadNotifs;
    }, 0);
  });

  const totalNotifications = $derived(
    (channelNotifications || 0) + (threadNotifications || 0),
  );
</script>

{#if channel && !channel.softDeleted}
  <!-- Channel -->
  <div class="group flex items-center gap-1 relative">
    <!-- <Button.Root
      href={navigateSync({
        space: page.params.space!,
        channel: channel.id,
      })}
      class="flex-1 cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border {channel.id === page.params.channel
        ? 'border-primary text-primary'
        : 'border-transparent'}"
    > -->

    <Button
      href={navigateSync({
        space: page.params.space!,
        channel: channel.id,
      })}
      variant="ghost"
      data-current={channel.id === page.params.channel}
    >
      <Icon icon="basil:comment-solid" class="shrink-0" />
      <span class="truncate">{channel?.name || "..."}</span>

      {#if totalNotifications}
        <span
          class="inline-flex items-center justify-center bg-primary font-bold text-base-100 rounded-full size-6"
        >
          {totalNotifications}
        </span>
      {/if}
    </Button>
    <!-- </Button.Root> -->

    {#if isNew}
      <div class="absolute top-1 left-1 size-2 bg-primary rounded-full"></div>
    {/if}
    {#if isSpaceAdmin(space)}
      <Button
        title="Delete"
        class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
        onclick={() => deleteItem(channel)}
      >
        <Icon icon="lucide:x" class="size-4" />
      </Button>
    {/if}
  </div>

  <!-- Threads under channel -->
  {#if channelThreads.length > 0}
    <div class="flex flex-col gap-1 ml-6">
      {#each channelThreads as thread}
        {#if thread}
          {@const threadNotifs = me?.profile?.roomyInbox?.filter(
            (x) => x?.threadId === thread.id && !x?.read,
          ).length}
          {@const isThreadNew = (() => {
            const lastRead = me?.root?.lastRead?.[thread.id];
            if (!lastRead) return false;
            const latestEntries = Object.values(
              thread?.timeline?.perAccount ?? {},
            ).sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime());
            if (latestEntries.length === 0) return false;
            const latestDate = latestEntries.at(-1)?.madeAt;
            return latestDate ? new Date(lastRead) < latestDate : false;
          })()}
          <div class="group flex items-center gap-1 relative">
            <Button
              variant="ghost"
              data-current={thread.id === page.params.thread}
              title={thread.name}
              onclick={() => {
                navigate({
                  space: page.params.space!,
                  thread: thread.id,
                });
              }}
               class="flex-1 cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border {thread.id === page.params.thread
                 ? 'border-primary text-primary'
                : 'border-transparent'} group-hover:pr-7"
            >
              <h4
                class="flex justify-start items-center w-full gap-2 px-2 text-sm"
              >
                <Icon icon="tabler:hash" class="shrink-0" />
                <span class="truncate">{thread.name || "..."}</span>

                {#if threadNotifs}
                  <span
                    class="inline-flex items-center justify-center bg-primary font-bold text-base-100 rounded-full size-5 text-xs shrink-0 ml-auto"
                  >
                    {threadNotifs}
                  </span>
                {/if}
              </h4>
            </Button>

            <Button
              title="Unsubscribe from thread"
              class="absolute right-0 top-0 bottom-0 w-6 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer flex items-center justify-center text-error hover:bg-error/10 rounded"
              onclick={(e) => {
                e.stopPropagation();
                unsubscribeFromThread(thread.id);
              }}
            >
              <Icon icon="tabler:x" class="size-3" />
            </Button>

            {#if isThreadNew}
              <div
                class="absolute top-1 left-1 size-2 bg-primary rounded-full"
              ></div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
{/if}
