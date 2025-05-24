<script lang="ts">
  import { globalState } from "$lib/global.svelte";
  import { JazzProvider } from "jazz-svelte";
  import { setContext } from "svelte";
  import type { Item } from "$lib/tiptap/editor";
  import { getProfile } from "$lib/profile.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { AccountSchema, Catalog } from "$lib/schema";
  // import { Message } from "@roomy-chat/sdk";
  import { Message } from "$lib/schema";
  let { children } = $props();
  const peerUrl = "wss://cloud.jazz.tools/?key=nandithebull@outlook.com";
  let sync = { peer: peerUrl };
  let users = []
  // TODO: track users via the space data
  // let users = derivePromise([], async () => {
  //   if (!globalState.space?.channels) {
  //     return [];
  //   }

  //   const channels = globalState.space.channels
  //   if (!channels.length) {
  //     return [];
  //   }

  //   // const result = new Set();

  //   // for (const channel of channels) {
  //   //     for (const message of channel?.messages || []) {
  //   //       if (message) {
  //   //         for (const author of message.authors((x) => x.toArray())) {
  //   //           result.add(author);
  //   //         }
  //   //       }
  //   //     }

  //   // }

  //   let arrayOfUsers: Item[];
  //   try {
  //     arrayOfUsers = (
  //       await Promise.all(
  //         [...result.values()].map(async (author) => {
  //           try {
  //             const profile = await getProfile(author as string);
  //             return {
  //               value: author,
  //               label: profile?.handle,
  //               category: "user",
  //             };
  //           } catch (err) {
  //             console.error("Error fetching user profile for", author, err);
  //             return null; // Skip this entity
  //           }
  //         }),
  //       )
  //     ).filter(Boolean) as Item[];
  //   } catch (err) {
  //     console.error("Error fetching user profiles", err);
  //     arrayOfUsers = [];
  //   }

  //   return arrayOfUsers;
  // });

  // let contextItems: { value: Item[] } = derivePromise([], async () => {
  //   if (!globalState.space) {
  //     return [];
  //   }
  //   const items = [];

  //   // add threads to list
  //   // for (const thread of await globalState.space.threads.items()) {
  //   //   if (!thread.softDeleted) {
  //   //     items.push({
  //   //       value: JSON.stringify({
  //   //         id: thread.id,
  //   //         space: globalState.space.id,
  //   //         type: "thread",
  //   //       }),
  //   //       label: thread.name,
  //   //       category: "thread",
  //   //     });
  //   //   }
  //   // }

  //   // add channels to list


  //   for (const channel of globalState.space.channels || []) {
  //     if (channel) {
  //       items.push({
  //         value: JSON.stringify({
  //           id: channel.id,
  //           space: globalState.space!.id,
  //           type: "channel",
  //         }),
  //         label: channel.name,
  //         category: "channel",
  //       });
  //     }
  //   }

  //   return items;
  // });

  // setContext("users", users);
  // setContext("contextItems", contextItems);
</script>

{#if globalState.space}
  <!-- Events/Room Content -->
  <main
    class="flex flex-col gap-4 p-4 grow min-w-0 h-full overflow-clip bg-base-100"
  >
    {@render children()}
  </main>

  <!-- If there is no space. -->
{:else}
  <span class="dz-loading dz-loading-spinner mx-auto"></span>
{/if}