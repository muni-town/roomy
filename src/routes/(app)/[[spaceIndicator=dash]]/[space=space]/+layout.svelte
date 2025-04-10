<script lang="ts">
  import { g } from "$lib/global.svelte";
  import type { Item } from "$lib/tiptap/editor";
  import { derivePromise } from "$lib/utils.svelte";
  import { getProfile } from "$lib/profile.svelte";
  import { setContext } from "svelte";
  import { Message } from "@roomy-chat/sdk";
  import { page } from "$app/state";
  import { outerWidth } from "svelte/reactivity/window";

  // TODO: track users via the space data
  let users = derivePromise([], async () => {
    if (!g.space) {
      return [];
    }

    const result = new Set();
    for (const channel of await g.space.channels.items()) {
      for (const timelineItem of await channel.timeline.items()) {
        const message = timelineItem.tryCast(Message);
        if (message && message.authors.length > 0) {
          for (const author of message.authors.toArray()) {
            result.add(author);
          }
        }
      }
    }
    const items = (await Promise.all(
      [...result.values()].map(async (author) => {
        const profile = await getProfile(author as string);
        return { value: author, label: profile?.handle, category: "user" };
      }),
    )) as Item[];

    return items;
  });
  let contextItems: { value: Item[] } = derivePromise([], async () => {
    if (!g.space) {
      return [];
    }
    const items = [];

    // add threads to list
    for (const thread of await g.space.threads.items()) {
      if (!thread.softDeleted) {
        items.push({
          value: JSON.stringify({
            id: thread.id,
            space: g.space.id,
            type: "thread",
          }),
          label: thread.name,
          category: "thread",
        });
      }
    }

    // add channels to list
    items.push(
      ...(await g.space.channels.items()).map((channel) => {
        return {
          value: JSON.stringify({
            id: channel.id,
            // TODO: I don't know that the space is necessary here or not.
            space: g.space!.id,
            type: "channel",
          }),
          label: channel.name,
          category: "channel",
        };
      }),
    );

    return items;
  });

  setContext("users", users);
  setContext("contextItems", contextItems);
  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);
</script>

{#if g.channel}
  <main
    class="drawer-content h-full overflox-x-auto flex flex-col gap-4 p-4 overflow-clip bg-base-100 {!isMobile
      ? 'grow min-w-0 rounded-xl border-4 border-base-300'
      : page.params.channel || page.params.thread
        ? 'absolute inset-0'
        : 'hidden'}"
  >
    {@render children()}
  </main>
{:else}
  <span class="loading loading-spinner mx-auto w-25"></span>
{/if}
