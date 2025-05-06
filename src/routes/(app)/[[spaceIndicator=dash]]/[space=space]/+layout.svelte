<script lang="ts">
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { outerWidth } from "svelte/reactivity/window";

  import { setContext } from "svelte";
  import type { Item } from "$lib/tiptap/editor";
  import { getProfile } from "$lib/profile.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { Message } from "@roomy-chat/sdk";
  import SidebarMain from "$lib/components/SidebarMain.svelte";

  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);

  // TODO: track users via the space data
  let users = derivePromise([], async () => {
    if (!g.space || !g.space.channels) {
      return [];
    }

    const result = new Set();
    for (const channel of await g.space.channels.items()) {
      for (const timelineItem of await channel.timeline.items()) {
        const message = timelineItem.tryCast(Message);
        if (message && message.authors.length > 0) {
          for (const author of message.authors((x) => x.toArray())) {
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

    for (const wiki of await g.space.wikipages.items()) {
      if (!wiki.softDeleted) {
        items.push({
          value: JSON.stringify({
            id: wiki.id,
            space: g.space.id,
            channel: g.channel?.id,
            type: "wiki",
          }),
          label: wiki.name,
          category: "wiki",
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
</script>

{#if g.space}
  <!-- Events/Room Content -->
  <main
    class="flex flex-col gap-4 p-4 grow min-w-0 h-full overflow-clip bg-base-100"
  >
    {@render children()}
  </main>

  <!-- If there is no space. -->
{:else}
  <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
{/if}
