import {
  Channel,
  EntityId,
  type EntityIdStr,
  Roomy,
  Space,
  Thread,
} from "@roomy-chat/sdk";
import { StorageManager } from "@muni-town/leaf/storage";
import { SveltePeer } from "@muni-town/leaf/svelte";
import { indexedDBStorageAdapter } from "@muni-town/leaf/storage/indexed-db";
import { webSocketSyncer } from "@muni-town/leaf/sync1/ws-client";

import { user } from "./user.svelte";
import type { Agent } from "@atproto/api";
import { page } from "$app/state";
import { goto } from "$app/navigation";
import { untrack } from "svelte";

import * as roomy from "@roomy-chat/sdk";
(window as any).r = roomy;

// Reload app when this module changes to prevent accumulated connections.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

export let g = $state({
  // Create an empty roomy instance by default, it will be updated when the user logs in.
  roomy: undefined as Roomy | undefined,
  space: undefined as Space | undefined,
  channel: undefined as Channel | Thread | undefined,
  isAdmin: false,
  currentCatalog: "home",
});
(globalThis as any).g = g;

$effect.root(() => {
  // Reload Roomy peer when login changes.
  $effect(() => {
    if (user.agent && user.catalogId.value) {
      // Initialize new roomy instance
      initRoomy(user.agent).then((roomy) => (g.roomy = roomy));
    } else {
      // Set a blank roomy instance just to avoid having to set it to undefined.
      Roomy.init(new SveltePeer(), new EntityId()).then((roomy) => {
        g.roomy = roomy;
      });
    }
  });

  /** Update the global space and channel when the route changes. */
  $effect(() => {
    page.url.pathname;
    page.params.space;
    if (!g.roomy) return;

    untrack(() => {
      if (page.url.pathname === "/home") {
        console.log("setting home");
        g.currentCatalog = "home";
      } else if (page.params.space) {
        console.log("space ID", page.params.space);
        if (page.params.space.includes(".")) {
          fetch(
            `https://leaf-resolver.roomy.chat/xrpc/town.muni.01JQ1SV7YGYKTZ9JFG5ZZEFDNK.resolve-leaf-id?domain=${encodeURIComponent(page.params.space)}`,
            {
              headers: [["accept", "application/json"]],
            },
          ).then(async (resp) => {
            console.log("got resp", resp);
            const json = await resp.json();
            const id = json.id;
            console.log("id", id);
            if (!id) {
              console.error("Leaf ID not found for domain:", page.params.space);
              goto("/home");
              return;
            }

            g.roomy!
              .open(Space, id as EntityIdStr)
              .then((space) => {
                console.log("space from domain", space);
                g.currentCatalog = id;
                g.space = space;
              })
              .catch((e) => {
                console.error(e);
              });
          });
        } else {
          console.log("id id", page.params.space);
          g.roomy!
            .open(Space, page.params.space as EntityIdStr)
            .then((space) => {
              console.log("space from id", space);
              g.currentCatalog = page.params.space!;
              g.space = space;
            });
        }
      }
    });
  });

  $effect(() => {
    if (!g.roomy) return;

    if (g.space && page.params.channel) {
      try {
        g.roomy
          .open(Channel, page.params.channel as EntityIdStr)
          .then((channel) => (g.channel = channel));
      } catch (e) {
        console.error("Error opening channel:", e);
        goto("/");
      }
    } else if (g.space && page.params.thread) {
      try {
        g.roomy
          .open(Thread, page.params.thread as EntityIdStr)
          .then((thread) => (g.channel = thread));
      } catch (e) {
        console.error("Error opening thread:", e);
        goto("/");
      }
    } else {
      g.channel = undefined;
    }
  });

  $effect(() => {
    if (g.space && user.agent) {
      g.isAdmin = g.space.admins.toArray().includes(user.agent.assertDid);
    } else {
      g.isAdmin = false;
    }
  });
});

async function initRoomy(agent: Agent): Promise<Roomy> {
  const catalogId = user.catalogId.value;
  if (!catalogId)
    throw new Error("Cannot initialize roomy without catalog ID.");

  // Fetch a syncserver authentication token
  const resp = await agent.call(
    "chat.roomy.v0.sync.token",
    undefined,
    undefined,
    {
      headers: {
        "atproto-proxy": "did:web:syncserver.roomy.chat#roomy_syncserver",
      },
    },
  );
  if (!resp.success) {
    throw new Error(`Error obtaining router auth token ${resp}`);
  }
  const token = resp.data.token as string;

  // Open router client
  const websocket = new WebSocket(
    `wss://syncserver.roomy.chat/sync/as/${agent.assertDid}`,
    ["authorization", token],
  );

  // Use this instead of you want to test with a local development Leaf syncserver.
  // const websocket = new WebSocket("ws://127.0.0.1:8095");

  const peer = new SveltePeer(
    new StorageManager(
      indexedDBStorageAdapter("roomy-01JQ0EP4SMJW9D58JXMV9E1CF2"),
    ),
    await webSocketSyncer(websocket),
  );

  return await Roomy.init(peer, catalogId as EntityIdStr);
}
