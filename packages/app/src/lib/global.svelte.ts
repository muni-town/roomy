import {
  Channel,
  type EntityIdStr,
  Roomy,
  Space,
  Thread,
  StorageManager,
} from "@roomy-chat/sdk";
import { SveltePeer } from "@muni-town/leaf-svelte";
import { indexedDBStorageAdapter } from "@muni-town/leaf-storage-indexeddb";
import { webSocketSyncer } from "@muni-town/leaf-sync-ws";
import { Charset, Document, Encoder, IndexedDB } from "flexsearch";

import { user } from "./user.svelte";
import { ComAtprotoIdentitySignPlcOperation, type Agent } from "@atproto/api";
import { page } from "$app/state";
import { untrack } from "svelte";
import { Index } from "flexsearch";
import { Message, type Timeline, type TimelineItem, type Space as RoomySpace, type Channel as RoomyChannel } from "@roomy-chat/sdk"; // Ensure Message type is available

import * as roomy from "@roomy-chat/sdk";
import { navigate, resolveLeafId } from "./utils.svelte";
import { getProfile } from "./profile.svelte";
(window as any).r = roomy;
(window as any).page = page;

// Reload app when this module changes to prevent accumulated connections.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
const encoder = new Encoder({
  include: {
      letter: true,
      number: true,
      punctuation: true 
  }
});
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
  activitySearchIndex: new Document({
    // preset: "match",
    // tokenize: "forward", // Handles arrays in 'authors' field appropriately for matching any author in the list
    document: {
      id: "id",
      // index:[
      //   {field: "author", tokenize: "forward",  encoder: Charset.LatinBalance},
      //   {field: "spaceId", tokenize: "forward", encoder: Charset.LatinBalance},
      //   // {field: "timestamp", tokenize: "forward", encoder: Charset.LatinBalance}
      // ],
      index: [
        "author",
        // "authors", // Array of author handles
        "spaceId",
        // "timestamp" // Numeric timestamp (message.createdDate.getTime())
      ],
      store: true // Store these fields to get them back in search results
    }
  }),
  messageSearchIndex: new Document({
    tokenize: "exact",
    encoder: encoder,
    document: {
      id: "id",
      index: [
        "authorDid" // Author's handle
      ],
      store: ["id", "content", "authorDid", "spaceId", "channelId", "timestamp"],
    },
    // worker: true
  }),
  indexing: true
});



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
      initRoomy(user.agent).then(async (roomy) => {
        globalState.roomy = roomy;
        // Once Roomy is initialized, start indexing all user messages
        if (globalState.roomy) { // Ensure roomy is available before indexing
          await indexAllUserMessages();
        }
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
      }
    });
  });

  $effect(() => {
    if (!globalState.roomy) return;

    if (globalState.space && page.params.channel) {
      globalState.roomy
        .open(Channel, page.params.channel as EntityIdStr)
        .then((channel) => (globalState.channel = channel))
        .catch((e) => {
          console.error("Error opening channel:", e);
          navigate("home");
        });
    } else if (globalState.space && page.params.thread) {
      globalState.roomy
        .open(Thread, page.params.thread as EntityIdStr)
        .then((thread) => (globalState.channel = thread))
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

/**
 * Indexes a message for the activity heatmap.
 * @param message The message object from the SDK.
 * @param spaceId The ID of the space this message belongs to.
 * @param authorDids Extracted author handles for the message.
 */
export async function indexMessageForActivity(
  message: Message,
  spaceId: string,
): Promise<void> {
  if (!message.id || !message.createdDate) {
    // console.warn("Skipping indexing for message due to missing data:", message.id);
    return;
  }
  const authors = message.authors((x) => x.toArray())
  const profile = await getProfile(authors[0])
  const handle = profile?.handle
  const doc = {
    id: String(message.id), // Ensure primitive string
    authors: authors, // Use the array of guaranteed primitive strings
    author: handle,
    spaceId: String(spaceId), // Ensure primitive string
    timestamp: message.createdDate.getTime(), // Already a number (primitive)
  };

  // Use plainDoc for indexing
  globalState.activitySearchIndex.add(doc);

}

export async function getMessageById(timeline: Timeline, messageId: string): Promise<Message | null> {
  if (!timeline) {
    console.error("Timeline is undefined. Cannot get message by ID.");
    return null;
  }

  // Step 1: Retrieve all TimelineItems and find the one with the matching ID.
  const allItems = await timeline.items(); // timeline.items() returns Promise<TimelineItem[]>
  const timelineItem = allItems.find(item => item.id === messageId); // Assuming TimelineItem has an 'id' property

  if (timelineItem) {
    // Step 2: Try to cast the TimelineItem to a Message.
    const message = timelineItem.tryCast(Message);
    return message; // This will be the Message object or null if the cast fails.
  }

  return null; // TimelineItem not found for the given messageId.
}

/**
 * Searches the activity index for messages by a specific author within a date range.
 * @param authorDid The handle of the author to search for.
 * @param minTimestamp The minimum timestamp for the search range.
 * @param maxTimestamp The maximum timestamp for the search range.
 * @returns A promise that resolves to an array of matching message data objects.
 */
export async function searchActivityByAuthor(
  authorDid: string,
) {
  if (!globalState.messageSearchIndex) {
    console.warn("messageSearchIndex not initialized. Cannot search activity.");
    return [];
  }
  try {
    const searchResults = await globalState.messageSearchIndex.searchAsync({
      query: authorDid,
      index: "authorDid", // Search in the 'authorDid' field
      enrich: true,        // Return the full stored documents
      // where: (doc: { timestamp: number }) =>
      //   doc.timestamp >= minTimestamp && doc.timestamp <= maxTimestamp,
      limit: 2000
    });

    const results = searchResults?.[0]?.result
    if(!results) return [];
    const uniqueResults = Array.from(new Set(results.map(item => item.id)))
    .map(id => results.find(item => item.id === id));
    return uniqueResults;
  } catch (error) {
    console.error("Error searching activity by author:", error);
    return [];
  }
}

/**
 * Indexes all messages from all spaces and channels for the current user.
 * This populates the `messageSearchIndex` for full-text search capabilities.
 */
export async function indexAllUserMessages(): Promise<void> {
  if (!globalState.roomy || !globalState.messageSearchIndex) {
    console.warn("Roomy SDK or messageSearchIndex not initialized. Skipping message indexing.");
    return;
  }
  const db = new IndexedDB("roomy-store")
  const searchIndex = globalState.messageSearchIndex;
  // await searchIndex.mount(db)
  console.log("Starting to index all user messages...");
  const roomy = globalState.roomy;
  let messagesIndexed = 0;

  try {
    const spaces = await roomy.spaces.items() as RoomySpace[];
    for (const space of spaces) {
      if (!space.channels) continue;
      const channels = await space.channels.items() as RoomyChannel[];
      for (const channel of channels) {
        if (!channel.timeline) continue;
        const timelineItems = await channel.timeline.items();
        for (const item of timelineItems) {
          const message = item.tryCast(Message);

          if (
            message
          ) {
            const authors = message.authors((x) => x.toArray());

            const authorDid = authors[0]
            const doc = {
              id: String(message.id),
              content: message.bodyJson,
              authorDid: authorDid,
              spaceId: String(space.id),
              channelId: String(channel.id),
              timestamp: message.createdDate.getTime(),
            };
            // Use addAsync if worker: true, otherwise add is synchronous
            // For simplicity without worker initially, using 'add'. If worker is enabled, switch to addAsync.
            // await searchIndex.addAsync(doc.id, doc); // if worker: true
            searchIndex.add(doc.id, doc)
            messagesIndexed++;
          }
        }
      }
    }
    console.log(`Finished indexing all user messages. Total messages indexed: ${messagesIndexed}`);
    globalState.indexing = false
  } catch (error) {
    console.error("Error indexing all user messages:", error);
  }
}
