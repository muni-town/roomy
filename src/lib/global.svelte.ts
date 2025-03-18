import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import type { Catalog, Channel, Space } from "./schemas/types";
import {
  namespacedSubstorage,
  RoomyPdsStorageAdapter,
} from "./autodoc-storage";
import { user } from "./user.svelte";
import catalogInit from "$lib/schemas/catalog.bin?uint8array&base64";
import channelInit from "$lib/schemas/channel.bin?uint8array&base64";
import spaceInit from "$lib/schemas/space.bin?uint8array&base64";
import { RouterClient } from "@jsr/roomy-chat__router/client";
import { Peer, Autodoc } from "./autodoc/peer";
import type { Agent } from "@atproto/api";
import { calculateSharedSecretEd25519 } from "./autodoc/encryption";
import { resolvePublicKey } from "./utils";
import { encryptedStorage } from "./autodoc/storage";
import { next as Automerge } from "@automerge/automerge";

export let g = $state({
  catalog: undefined as Autodoc<Catalog> | undefined,
  dms: {} as { [did: string]: Autodoc<Channel> },
  spaces: {} as { [ulid: string]: Autodoc<Space> },
  router: undefined as RouterClient | undefined,
  routerConnections: {} as { [did: string]: string[] },
  peer: undefined as Peer | undefined,
});
(globalThis as any).g = g;

async function createPeer(agent: Agent, privateKey: Uint8Array): Promise<Peer> {
  // Fetch a router authentication token
  const resp = await agent.call(
    "chat.roomy.v0.router.token",
    undefined,
    undefined,
    {
      headers: {
        "atproto-proxy": "did:web:v0.router.roomy.chat#roomy_router",
      },
    },
  );
  if (!resp.success) {
    throw new Error(`Error obtaining router auth token ${resp}`);
  }
  const token = resp.data.token as string;

  // Open router client
  const router = new RouterClient(
    token,
    `wss://v0.router.roomy.chat/connect/as/${agent.assertDid}`,
  );

  // Initialize peer
  return await Peer.init({
    router,
    privateKey,
    async storageFactory(docId) {
      return namespacedSubstorage(
        new IndexedDBStorageAdapter("roomy", "autodoc"),
        docId,
      );
    },
    async publicStorageFactory(docId) {
      if (docId.startsWith("catalog/")) {
        return encryptedStorage(
          privateKey,
          namespacedSubstorage(new RoomyPdsStorageAdapter(agent), docId),
        );
      } else if (docId.startsWith("dm/")) {
        const dids = docId.split("/").slice(1);
        const otherDid = dids.find((x) => x !== agent.assertDid);
        if (!otherDid) {
          // Note: the other DID might be null if we DM ourself, which is fine.
          if (dids[0] === dids[1]) {
            return encryptedStorage(
              privateKey,
              namespacedSubstorage(new RoomyPdsStorageAdapter(agent), docId),
            );
          } else {
            throw `Invalid DM doc ID: ${docId}`;
          }
        }

        const otherPublicKey = await resolvePublicKey(otherDid);
        const encryptionKey = calculateSharedSecretEd25519(
          privateKey,
          otherPublicKey,
        );
        return encryptedStorage(
          encryptionKey,
          namespacedSubstorage(
            new RoomyPdsStorageAdapter(agent, otherDid),
            docId,
          ),
        );
      } else {
        let extraDids: string[] = [];
        // Try to get the list of optimal peers to initially sync with for the space
        try {
          const resp = await fetch(
            `https://spaces.roomy.chat/xrpc/chat.roomy.v0.space.sync.peers?docId=${docId}`,
          );
          const data: { peers: string[] } = await resp.json();
          extraDids = data.peers;
        } catch (e) {
          console.warn(`Couldn't get peers to sync with from spaces server`, e);
        }
        return namespacedSubstorage(
          new RoomyPdsStorageAdapter(agent, ...extraDids),
          docId,
        );
      }
    },
  });
}

$effect.root(() => {
  // Create peer when agent is initialized
  $effect(() => {
    if (user.agent && user.keypair.value?.privateKey && !g.peer) {
      createPeer(user.agent, user.keypair.value.privateKey).then((peer) => {
        g.peer = peer;

        // Sync changes to the space server after updating public storage
        peer.addEventListener("public-storage-saved", ({ docId }) => {
          const doc = g.peer?.docs.get(docId);
          if (!doc) return;
          if (!docId.startsWith("space/")) return;

          console.log("updating spaces");
          user.agent?.call(
            "chat.roomy.v0.space.update",
            undefined,
            {
              [docId]: Automerge.getAllChanges(doc.view)
                .map(Automerge.decodeChange)
                .map((x) => ({ hash: x.hash, deps: x.deps })),
            },
            {
              headers: {
                "atproto-proxy": "did:web:spaces.roomy.chat#roomy_spaces",
              },
            },
          );
        });
      });
    }
  });

  // Create catalog when peer is initialized
  $effect(() => {
    if (user.agent && g.peer && !g.catalog) {
      g.catalog = g.peer.open(`catalog/${user.agent.assertDid}`, catalogInit);
    }
  });

  // Open Automerge documents when they are added to the catalog
  $effect(() => {
    if (user.agent && user.keypair.value && g.peer) {
      // Create an Autodoc for every direct message in the catalog.
      for (const did of Object.keys(g.catalog?.view.dms || {})) {
        if (!Object.hasOwn(g.dms, did)) {
          (async () => {
            if (!(user.agent && user.keypair.value && g.peer)) return;

            // Create docId from DIDs
            let dids = [did, user.agent.assertDid];
            dids.sort();
            const docId = `dm/${dids.join("/")}`;

            // Open the doc
            const doc = g.peer.open<Channel>(docId, channelInit);
            g.dms[did] = doc;
          })();
        }
      }

      // Create an Autodoc for every space.
      for (const { id } of g.catalog?.view.spaces || []) {
        if (!Object.hasOwn(g.spaces, id)) {
          (async () => {
            if (!(user.agent && user.keypair.value && g.peer)) return;

            const docId = `space/${id}`;

            // Open the doc
            const doc = g.peer.open<Space>(docId, spaceInit);
            g.spaces[id] = doc;
          })();
        }
      }
    }
  });
});
