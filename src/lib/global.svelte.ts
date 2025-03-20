import {
  Channel,
  components,
  EntityId,
  type EntityIdStr,
  type IntoEntityId,
  NamedEntity,
  Peer,
  Roomy,
  Image,
  Space,
  Thread,
} from "@roomy-chat/sdk";
import { StorageManager } from "@muni-town/leaf/storage";
import { SveltePeer } from "@muni-town/leaf/svelte";
import { indexedDBStorageAdapter } from "@muni-town/leaf/storage/indexed-db";
import { webSocketSyncer } from "@muni-town/leaf/sync1/ws-client";

import { user } from "./user.svelte";
import type { Agent } from "@atproto/api";

// Reload app when this module changes to prevent accumulated connections.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

export let g = $state({
  // Create an empty roomy instance by default, it will be updated when the user logs in.
  roomy: await Roomy.init(new Peer(), new EntityId()),
  space: undefined as Space | undefined,
  channel: undefined as Channel | Thread | undefined,
  isAdmin: false,
});
(globalThis as any).g = g;

$effect.root(() => {
  // Reload Roomy peer when login changes.
  $effect(() => {
    g.space = undefined;
    g.channel = undefined;
    if (user.agent && user.catalogId.value) {
      // Initialize new roomy instance
      initRoomy(user.agent).then((roomy) => (g.roomy = roomy));
    } else {
      // Set a blank roomy instance just to avoid having to set it to undefined.
      Roomy.init(new Peer(), new EntityId()).then((roomy) => {
        g.roomy = roomy;
      });
    }
  });
});


async function initRoomy(agent: Agent): Promise<Roomy> {
  const catalogId = user.catalogId.value;
  if (!catalogId)
    throw new Error("Cannot initialize roomy without catalog ID.");

  // // Fetch a syncserver authentication token
  // const resp = await agent.call(
  //   "chat.roomy.v0.sync.token",
  //   undefined,
  //   undefined,
  //   {
  //     headers: {
  //       "atproto-proxy": "did:web:syncserver.roomy.chat#roomy_syncserver",
  //     },
  //   },
  // );
  // if (!resp.success) {
  //   throw new Error(`Error obtaining router auth token ${resp}`);
  // }
  // const token = resp.data.token as string;

  // // Open router client
  // const websocket = new WebSocket(
  //   `wss://syncserver.roomy.chat/sync/as/${agent.assertDid}`,
  //   ["authorization", token],
  // );

  const websocket = new WebSocket("ws://127.0.0.1:8095");

  const peer = new SveltePeer(
    new StorageManager(indexedDBStorageAdapter("roomy")),
    await webSocketSyncer(websocket),
  );

  return await Roomy.init(peer, catalogId as EntityIdStr);
}
