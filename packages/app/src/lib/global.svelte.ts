import {
  Channel,
  EntityId,
  type EntityIdStr,
  Roomy,
  Space,
  Thread,
  StorageManager,
} from "@roomy-chat/sdk";
import { SveltePeer } from "@muni-town/leaf-svelte";
import { indexedDBStorageAdapter } from "@muni-town/leaf-storage-indexeddb";
import { webSocketSyncer } from "@muni-town/leaf-sync-ws";

import { user } from "./user.svelte";
import type { Agent } from "@atproto/api";
import { page } from "$app/state";
import { untrack } from "svelte";

import * as roomy from "@roomy-chat/sdk";
import { navigate, resolveLeafId } from "./utils.svelte";
import { setCustomIconsLoader } from "@iconify/svelte";
(window as any).r = roomy;
(window as any).page = page;

// Reload app when this module changes to prevent accumulated connections.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

export let globalState = $state({
  // Create an empty roomy instance by default, it will be updated when the user logs in.
  roomy: undefined as Roomy | undefined,
  /**
   * This is set to the value page.params.space once the space has been loaded. It allows other code
   * to check whether or not `globalState.space` has been loaded after a route change or if it is still set to
   * the value from the previous route.
   * */
  loadedSpace: undefined as string | undefined,
  space: undefined as Space | undefined,
  channel: undefined as Channel | Thread | undefined,
  isAdmin: false,
  isBanned: false,
  currentCatalog: "home",
  _scrollPositions: {} as Record<string, number>, // Private state for scroll positions
  saveScrollPosition: (channelId: string, position: number) => {
    if (typeof window === 'undefined') return;
    const state = JSON.parse(localStorage.getItem('scrollPositions') || '{}');
    state[channelId] = position;
    localStorage.setItem('scrollPositions', JSON.stringify(state));
    globalState._scrollPositions = { ...globalState._scrollPositions, [channelId]: position };
  },
  getScrollPosition: (channelId: string): number => {
    if (typeof window === 'undefined') return 0;
    // Check if we already have the position in memory
    if (globalState._scrollPositions[channelId] !== undefined) {
      return globalState._scrollPositions[channelId];
    }
    // If not, try to load from localStorage
    try {
      const state = JSON.parse(localStorage.getItem('scrollPositions') || '{}');
      // Update the in-memory cache without triggering reactivity
      Object.assign(globalState._scrollPositions, state);
      return state[channelId] || 0;
    } catch (e) {
      console.error('Error reading scroll positions from localStorage', e);
      return 0;
    }
  },
  saveChannelState: (spaceId: string, channelId?: string) => {
    if (typeof window === 'undefined') return;
    const state = JSON.parse(localStorage.getItem('channelState') || '{}');
    const spaceKey = page.params.space || spaceId;
    if (channelId) {
      state[spaceKey] = channelId;
    } else {
      delete state[spaceKey]; // Remove the entry if no channel is provided
    }
    localStorage.setItem('channelState', JSON.stringify(state));
  },
  
  // Add this function to get the last channel for a space
  getLastChannel: (spaceId: string): string | null => {
    if (typeof window === 'undefined') return null;
    const state = JSON.parse(localStorage.getItem('channelState') || '{}');
    return state[spaceId] || (page.params.space ? state[page.params.space] : null);

  }
});

const entityId = new EntityId();

$effect.root(() => {
  // Redirect to the `/-/space.domain` or `/leaf:id` as appropriate.
  $effect(() => {
    if (
      (page.params.space &&
        page.params.spaceIndicator !== undefined &&
        page.params.space.startsWith("leaf:")) ||
      (page.params.space &&
        page.params.spaceIndicator === undefined &&
        !page.params.space.startsWith("leaf:"))
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
      // Initialize new roomy instance
      initRoomy(user.agent).then((roomy) => (globalState.roomy = roomy));
    } else {
      // Set a blank roomy instance just to avoid having to set it to undefined.
      Roomy.init(new SveltePeer(), entityId).then((roomy) => {
        globalState.roomy = roomy;
      });
    }
  });

  /** Update the global space and channel when the route changes. */
  $effect(() => {
    page.url.pathname;
    page.params.space;
    if (!globalState.roomy) return;

    untrack(() => {
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

            globalState
              .roomy!.open(Space, id)
              .then((space) => {
                globalState.loadedSpace = page.params.space!;
                globalState.currentCatalog = id;
                globalState.space = space;
              })
              .catch((e) => {
                console.error(e);
              });
          });
        } else {
          globalState
            .roomy!.open(Space, page.params.space as EntityIdStr)
            .then((space) => {
              globalState.loadedSpace = page.params.space!;
              globalState.currentCatalog = page.params.space!;
              globalState.space = space;
            });
        }
        if (!page.params.channel && !page.params.thread) {
          const lastChannel = globalState.getLastChannel(page.params.space);
          console.dir(lastChannel)
          if (lastChannel) {
            // Check if it's a thread or channel by the ID format
            if (lastChannel.startsWith('thread_')) {
            const threadId = lastChannel.split('_').pop() || '';

              navigate({ space: page.params.space, thread: threadId });
            } else {
              navigate({ space: page.params.space, channel: lastChannel });
            }
            return;
          }
        }

      }
    });
  });

  $effect(() => {
    if (!globalState.roomy) return;

    if (globalState.space && page.params.channel) {
      globalState.roomy
        .open(Channel, page.params.channel as EntityIdStr)
        .then((channel) => {
          globalState.channel = channel;
          globalState.saveChannelState(globalState.space!.id, channel.id);
        })
        .catch((e) => {
          console.error("Error opening channel:", e);
          navigate("home");
        });
    } else if (globalState.space && page.params.thread) {
      globalState.roomy
        .open(Thread, page.params.thread as EntityIdStr)
        .then((thread) => {
          globalState.channel = thread;
          globalState.saveChannelState(globalState.space!.id, `thread_${thread.id}`);
        })
        .catch((e) => {
          console.error("Error opening thread:", e);
          navigate("home");
        });
      globalState.channel = undefined;
    }
  });

  $effect(() => {
    if (globalState.space && user.agent) {
      globalState.isAdmin = globalState.space.admins((x) =>
        x.toArray().includes(user.agent!.assertDid),
      );
      globalState.isBanned = !!globalState.space.bans((x) =>
        x.get(user.agent!.assertDid),
      );
    } else {
      globalState.isAdmin = false;
      globalState.isBanned = false;
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
    throw new Error(
      `Error obtaining router auth token ${JSON.stringify(resp)}`,
    );
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
