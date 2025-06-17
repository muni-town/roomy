<script lang="ts">
  import { page } from "$app/state";
  import { RoomyAccount, LastReadList } from "$lib/jazz/schema";
  import { AccountCoState } from "jazz-svelte";
  // import type { NamedEntity } from "@roomy-chat/sdk";
  import type { Snippet } from "svelte";

  let {
    title,
    items,
    route,
    children,
    header,
  }: {
    title: string;
    items: any[];
    route: string;
    selected?: boolean;
    children?: Snippet;
    header?: Snippet;
  } = $props();
  let itemLink = (item: { id: string }) =>
    `${page.params.space?.includes(".") ? "/-" : ""}/${page.params.space}/${route}/${item.id}`;

  // Add account access to mark threads as read
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      root: {
        lastRead: true,
      },
      profile: {
        threadSubscriptions: true,
      },
    },
  });

  // Function to mark thread as read when clicked
  function markThreadAsRead(threadId: string) {
    console.log('🔗 BoardList: Marking thread as read:', threadId);
    if (!me?.current?.root) {
      console.log('❌ BoardList: No me.current.root available');
      return;
    }

    if (!me.current.root.lastRead) {
      console.log('📝 BoardList: Creating new lastRead object');
      me.current.root.lastRead = LastReadList.create({});
    }

    // Mark the thread as read so it appears in sidebar
    me.current.root.lastRead[threadId] = new Date();
    
    // Remove any unsubscribe entry for this thread since we're actively viewing it
    if (me.current?.profile?.threadSubscriptions) {
      const unsubscribeEntry = `unsubscribe:${threadId}`;
      const subscriptions = me.current.profile.threadSubscriptions;
      const index = subscriptions.indexOf(unsubscribeEntry);
      if (index !== -1) {
        console.log('🔄 BoardList: Removing unsubscribe entry for thread:', threadId);
        subscriptions.splice(index, 1);
      }
    }
    
    console.log('✅ BoardList: Thread marked as read:', {
      threadId,
      timestamp: me.current.root.lastRead[threadId],
      allLastRead: Object.keys(me.current.root.lastRead || {})
    });
  }
</script>

<div class="flex justify-between items-center">
  <h3 class="text-xl font-bold text-base-content">{title}</h3>
  {@render header?.()}
</div>
<ul class="dz-list w-full dz-join dz-join-vertical rounded">
  {#each items as item}
    {#if item}
      <a
        href={itemLink(item)}
        onclick={() => {
          // When clicking on a thread from the board, mark it as read
          // so it appears in the sidebar
          if (route === "thread") {
            markThreadAsRead(item.id);
          }
        }}
      >
        <li
          class="dz-list-row dz-card-title dz-join-item bg-base-200 text-md group w-full"
        >
          {item.name}
        </li>
      </a>
    {/if}
  {:else}
    {@render children?.()}
  {/each}
</ul>
