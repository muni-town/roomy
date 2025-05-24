// import {
//   Channel,
//   type EntityIdStr,
//   Roomy,
//   Space,
//   Thread,
//   StorageManager,
// } from "@roomy-chat/sdk";
import { SveltePeer } from "@muni-town/leaf-svelte";
import { indexedDBStorageAdapter } from "@muni-town/leaf-storage-indexeddb";
import { webSocketSyncer } from "@muni-town/leaf-sync-ws";

import { user } from "./user.svelte";
import type { Agent } from "@atproto/api";
import { page } from "$app/state";
import { untrack } from "svelte";

import { Space, Channel, Thread, Catalog, Messages } from "./schema.ts";

// import * as roomy from "@roomy-chat/sdk";
import { navigate, resolveLeafId } from "./utils.svelte";
// (window as any).r = roomy;
(window as any).page = page;

// Reload app when this module changes to prevent accumulated connections.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

export let globalState = $state({
  // Create an empty roomy instance by default, it will be updated when the user logs in.
  // roomy: undefined as Roomy | undefined,
  /**
   * This is set to the value page.params.space once the space has been loaded. It allows other code
   * to check whether or not `globalState.space` has been loaded after a route change or if it is still set to
   * the value from the previous route.
   * */
  catalog: undefined as Catalog | undefined | null,
  loadedSpace: undefined as string | undefined,
  space: undefined as Space | undefined | null,
  channel: undefined as Channel | Thread | undefined | null,
  isAdmin: false,
  isBanned: false,
  currentCatalog: "home",
});

$effect.root(() => {
  // Redirect to the `/-/space.domain` or `/co_id` as appropriate.
  $effect(() => {
    if (
      (page.params.space &&
        page.params.spaceIndicator !== undefined &&
        page.params.space.startsWith("co_")) ||
      (page.params.space &&
        page.params.spaceIndicator === undefined &&
        !page.params.space.startsWith("co_"))
    ) {
      navigate({
        space: page.params.space,
        channel: page.params.channel,
        thread: page.params.thread,
      });
    }
  });

  // Reload Roomy peer when login changes.
  $effect(() => {
    if (user.agent && user.catalogId.value) {
      console.log("user.agent", user.agent)
      if(!globalState.catalog){
        Catalog.load(user.catalogId.value, {resolve: {spaces: {$each: true}}}).then((catalog) =>  {
          console.log("catalog",catalog?.toJSON())
          globalState.catalog = catalog
        })
      } 
      // Initialize new roomy instance
      // initRoomy(user.agent).then((roomy) => (globalState.roomy = roomy));
    }
  });

  /** Update the global space and channel when the route changes. */
  $effect(() => {
    page.url.pathname;
    page.params.space;
    // if (!globalState.roomy) return;

    untrack(async () => {
      if (page.url.pathname === "/home") {
        globalState.currentCatalog = "home";
      } else if (page.params.space) {
        if (page.params.space.includes(".")) {
          resolveLeafId(page.params.space).then(async (id) => {
            if (!id) {
              console.error("Leaf ID not found for domain:", page.params.space);
              navigate("home");
              return;
            }

            const space = await Space.load(id, {resolve: {channels: {$each: true}}})
            globalState.loadedSpace = page.params.space!;
            globalState.currentCatalog = id;
            console.log("setting space")
            globalState.space = space;
          })
            .catch((e) => {
              console.error(e);
            });

        } else {
          const space = await Space.load(page.params.space, {resolve: {channels: {$each: true}}})
          globalState.loadedSpace = page.params.space!;
          globalState.currentCatalog = page.params.space!;
          console.log("setting space")
          globalState.space = space;
        }
      }
    }
    );
  });

  $effect(() => {
    // if (!globalState.roomy) return;

    if (globalState.space && page.params.channel) {
      Channel.load(page.params.channel, {resolve: {messages: {$each: true}}}).then((channel) => {
        globalState.channel = channel;
      })
      

    } else if (globalState.space && page.params.thread) {
      Thread.load(page.params.thread).then((thread) => (globalState.channel = thread))
        .catch((e) => {
          console.error("Error opening thread:", e);
          navigate("home");
        });
      globalState.channel = undefined;
    }
  });

  // $effect(() => {
  //   if (globalState.space && user.agent) {
  //     globalState.isAdmin = globalState.space.admins((x) =>
  //       x.toArray().includes(user.agent!.assertDid),
  //     );
  //     globalState.isBanned = !!globalState.space.bans((x) =>
  //       x.get(user.agent!.assertDid),
  //     );
  //   } else {
  //     globalState.isAdmin = false;
  //     globalState.isBanned = false;
  //   }
  // });
});

// async function initRoomy(agent: Agent): Promise<Roomy> {
//   const catalogId = user.catalogId.value;
//   if (!catalogId)
//     throw new Error("Cannot initialize roomy without catalog ID.");

//   // Fetch a syncserver authentication token
//   const resp = await agent.call(
//     "chat.roomy.v0.sync.token",
//     undefined,
//     undefined,
//     {
//       headers: {
//         "atproto-proxy": "did:web:syncserver.roomy.chat#roomy_syncserver",
//       },
//     },
//   );
//   if (!resp.success) {
//     throw new Error(
//       `Error obtaining router auth token ${JSON.stringify(resp)}`,
//     );
//   }
//   const token = resp.data.token as string;

//   // Open router client
//   const websocket = new WebSocket(
//     `wss://syncserver.roomy.chat/sync/as/${agent.assertDid}`,
//     ["authorization", token],
//   );

//   // Use this instead of you want to test with a local development Leaf syncserver.
//   // const websocket = new WebSocket("ws://127.0.0.1:8095");

//   const peer = new SveltePeer(
//     new StorageManager(
//       indexedDBStorageAdapter("roomy-01JQ0EP4SMJW9D58JXMV9E1CF2"),
//     ),
//     await webSocketSyncer(websocket),
//   );

//   return await Roomy.init(peer, catalogId as EntityIdStr);
// }
