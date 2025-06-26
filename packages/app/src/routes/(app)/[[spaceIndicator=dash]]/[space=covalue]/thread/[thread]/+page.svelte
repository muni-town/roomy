<script lang="ts">
  import TimelineView from "$lib/components/TimelineView.svelte";
  import AtprotoThreadView from "$lib/components/AtprotoThreadView.svelte";
  import { CoState } from "jazz-svelte";
  import { Thread, Message } from "@roomy-chat/sdk";
  import { page } from "$app/state";

  let thread = $derived(new CoState(Thread, page.params.thread));
  let firstMessage = $derived(
    thread.current?.timeline?.perAccount ? 
      Object.values(thread.current.timeline.perAccount)
        .map(accountFeed => new Array(...accountFeed.all))
        .flat()
        .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
        .map(a => a.value)?.[0] : null
  );
  
  let message = $derived(new CoState(Message, firstMessage || ""));
  
  // Check if this is an ATProto thread by looking for Bluesky URLs in the content
  let isAtprotoThread = $derived(
    message.current?.content?.includes('bsky.app/profile/') && 
    message.current?.content?.includes('/post/') &&
    thread.current?.name?.startsWith('💬')
  );
</script>

{#if isAtprotoThread}
  <AtprotoThreadView threadId={page.params.thread} />
{:else}
  <TimelineView />
{/if}
