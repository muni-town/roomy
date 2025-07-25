import { Channel, Message, Thread, Space } from "@roomy-chat/sdk";
import { Charset, Document, IndexedDB } from "flexsearch";
import type { co } from "jazz-tools";

let search: { [spaceId: string]: Document | null } = $state({});

export async function initSearch(space: co.loaded<typeof Space>) {
  return;
  if (!space) return;

  console.log("Initializing search for space:", space.id, space.name);

  const db = new IndexedDB("roomy-search-index-" + space.id);

  search[space.id] = new Document({
    document: {
      id: "messageId",
      store: true,
      index: ["username", "channelName", "messageContent"],
      tag: ["threadId", "channelId", "username"],
    },
    tokenize: "forward",
    encoder: Charset.LatinBalance,
  });

  await search[space.id]?.mount(db);

  for (const c of space.channels ?? []) {
    if (!c) continue;
    // get last indexed messag id for channel
    const lastIndexedMessageId = localStorage.getItem(
      `lastIndexedMessageId-${c.id}`,
    );

    // load timeline for channel
    const channel = await Channel.load(c.id, {
      resolve: {
        mainThread: {
          timeline: {
            $each: true,
            $onError: null,
          },
        },
      },
    });
    if (!channel) continue;

    //console.log("loaded channel", c.id, c.name);

    // sort timeline and filter out null/undefined values
    let timeline = Object.values(channel.mainThread?.timeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .filter((entry) => entry && entry.value) // Filter out null/undefined entries
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value)
      .filter((messageId) => messageId); // Filter out null/undefined message IDs

    // if we have an existing last indexed message id, start from there, otherwise start from the beginning
    let startIndex = 0;
    if (lastIndexedMessageId) {
      const lastIndexedPosition = timeline.indexOf(lastIndexedMessageId);
      if (lastIndexedPosition >= 0) {
        startIndex = lastIndexedPosition + 1;
        console.log(
          `Continuing indexing from message ${lastIndexedPosition + 1} in channel: ${c.name}`,
        );
      } else {
        console.warn(
          `Last indexed message ${lastIndexedMessageId} not found in timeline for channel: ${c.name}, restarting from beginning`,
        );
        localStorage.removeItem(`lastIndexedMessageId-${c.id}`);
      }
    }

    // console.log(
    //   "indexing channel",
    //   c.name,
    //   "from",
    //   startIndex,
    //   "to",
    //   timeline.length,
    // );

    console.log(
      `Indexing ${timeline.length - startIndex} messages for channel: ${c.name}`,
    );

    // add messages to index
    for (let i = startIndex; i < timeline.length; i++) {
      const messageId = timeline[i];
      if (!messageId) continue;

      await addMessageWithIndex(space.id, messageId, c.id, c.name);

      // update last indexed message id for channel
      localStorage.setItem(`lastIndexedMessageId-${c.id}`, messageId);
    }

    console.log("Indexed channel:", c.name);
  }

  for (const t of space.threads ?? []) {
    if (!t) continue;

    // get last indexed messag id for thread
    const lastIndexedMessageId = localStorage.getItem(
      `lastIndexedMessageId-${t.id}`,
    );

    // load timeline for thread
    const thread = await Thread.load(t.id, {
      resolve: {
        timeline: {
          $each: true,
          $onError: null,
        },
      },
    });
    if (!thread) continue;

    // sort timeline and filter out null/undefined values
    let timeline = Object.values(thread.timeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .filter((entry) => entry && entry.value) // Filter out null/undefined entries
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value)
      .filter((messageId) => messageId); // Filter out null/undefined message IDs

    // if we have an existing last indexed message id, start from there, otherwise start from the beginning
    let startIndex = 0;
    if (lastIndexedMessageId) {
      const lastIndexedPosition = timeline.indexOf(lastIndexedMessageId);
      if (lastIndexedPosition >= 0) {
        startIndex = lastIndexedPosition + 1;
        console.log(
          `Continuing indexing from message ${lastIndexedPosition + 1} in thread: ${t.name || t.id}`,
        );
      } else {
        console.warn(
          `Last indexed message ${lastIndexedMessageId} not found in timeline for thread: ${t.name || t.id}, restarting from beginning`,
        );
        localStorage.removeItem(`lastIndexedMessageId-${t.id}`);
      }
    }

    console.log(
      `Indexing ${timeline.length - startIndex} messages for thread: ${t.name || t.id}`,
    );

    // add messages to index
    for (let i = startIndex; i < timeline.length; i++) {
      const messageId = timeline[i];
      if (!messageId) continue;

      await addMessageWithIndex(space.id, messageId, t.id, t.name);

      // update last indexed message id for thread
      localStorage.setItem(`lastIndexedMessageId-${t.id}`, messageId);
    }

    console.log("Indexed thread:", t.name || t.id);
  }

  console.log(
    `Search initialization completed for space: ${space.id} (${indexedCount} messages indexed)`,
  );
  indexedCount = 0; // Reset counter for this space
}

export async function addMessageWithIndex(
  spaceId: string,
  messageId: string,
  channelId?: string,
  channelName?: string,
  threadId?: string,
  threadName?: string,
) {
  let message;
  try {
    // load message with simpler resolution (avoid _edits)
    message = await Message.load(messageId);
    if (!message) {
      console.warn("Failed to load message for indexing:", messageId);
      throw new Error(`Message ${messageId} could not be loaded`);
    }

    // Check if message has content - allow empty messages but log them
    if (!message.content || message.content.trim() === "") {
      console.debug(
        "Message has no content, indexing with metadata only:",
        messageId,
      );
      // Don't return early - still index the message with its metadata
    }
  } catch (error) {
    console.error("Error loading message for indexing:", messageId, error);
    throw error;
  }

  // add message to index
  addMessage(spaceId, {
    messageId: message.id,
    messageContent: message.content || "",
    channelName: channelName,
    channelId: channelId,
    threadName: threadName,
    threadId: threadId,
    username:
      message?.author?.split(":")[1] ||
      message?._edits?.content?.by?.profile?.name ||
      "",
    userId: message?._edits?.content?.by?.profile?.id || "",
  });
}

let indexedCount = 0;

export function addMessage(
  spaceId: string,
  messageData: {
    messageId: string;
    messageContent: string;
    channelName?: string;
    channelId?: string;
    threadName?: string;
    threadId?: string;
    username: string;
    userId: string;
  },
) {
  if (!search[spaceId]) {
    console.error("no search index for space", spaceId);
    return;
  }

  indexedCount++;
  if (indexedCount % 20 === 0) {
    console.log(`Indexed ${indexedCount} messages...`);
  }

  try {
    search[spaceId].add(messageData.messageId, messageData);
  } catch (error) {
    console.error("Error adding message to index:", error, messageData);
  }
}

export function debugSearchIndex(spaceId: string) {
  const index = search[spaceId];
  if (!index) {
    console.log("❌ No search index found for space:", spaceId);
    console.log("Available spaces:", Object.keys(search));
    return null;
  }

  console.log("✅ Search index exists for space:", spaceId);
  console.log("📊 Index type: FlexSearch Document");

  return {
    exists: true,
    spaceId: spaceId,
    indexObject: index,
  };
}

// Get some sample data from the index to see what's actually indexed
export async function inspectSearchIndex(spaceId: string, sampleSize = 5) {
  const index = search[spaceId];
  if (!index) {
    console.log("❌ No search index found for space:", spaceId);
    return;
  }

  console.log(`🔍 Inspecting search index for space: ${spaceId}`);

  // Try searching for common words to see what's in the index
  const commonTerms = [
    "the",
    "and",
    "a",
    "to",
    "is",
    "it",
    "in",
    "you",
    "that",
    "of",
  ];

  for (const term of commonTerms.slice(0, 3)) {
    try {
      const results = await index.search(term, {
        limit: sampleSize,
        enrich: true,
      });
      if (results && results.length > 0) {
        console.log(
          `📝 Found ${results.length} field(s) with term "${term}":`,
          results,
        );
        break; // Found some data, that's enough
      }
    } catch (error) {
      console.warn("Error searching for term:", term, error);
    }
  }
}

// Check if a specific message ID is in the index
export async function findMessageInIndex(spaceId: string, messageId: string) {
  const index = search[spaceId];
  if (!index) {
    console.log("❌ No search index found for space:", spaceId);
    return false;
  }

  try {
    // Search for the exact message ID
    const results = await index.search("*", {
      limit: 1000,
      enrich: true,
      filter: (doc: any) => doc.id === messageId,
    });

    const found = results.some((fieldResult: any) =>
      fieldResult.result?.some(
        (doc: any) => (typeof doc === "string" ? doc : doc.id) === messageId,
      ),
    );

    console.log(
      `🎯 Message ${messageId} ${found ? "FOUND" : "NOT FOUND"} in index`,
    );
    return found;
  } catch (error) {
    console.warn("Error checking for message:", error);
    return false;
  }
}

// Search for messages containing specific text and show details
export async function searchAndShowDetails(
  spaceId: string,
  searchText: string,
) {
  const index = search[spaceId];
  if (!index) {
    console.log("❌ No search index found for space:", spaceId);
    return;
  }

  console.log(`🔍 Searching for "${searchText}" in space: ${spaceId}`);

  try {
    const results = await index.search(searchText, {
      limit: 10,
      enrich: true,
    });

    console.log(`📊 Raw search results:`, results);

    if (!results || results.length === 0) {
      console.log("❌ No results found");
      return;
    }

    // Parse and show details of found messages
    const messageIds = [];
    for (const fieldResult of results) {
      if (fieldResult && fieldResult.result) {
        for (const doc of fieldResult.result) {
          const messageId = typeof doc === "string" ? doc : doc.id;
          if (messageId && !messageIds.includes(messageId)) {
            messageIds.push(messageId);

            // Try to load the actual message to show its content
            try {
              const message = await Message.load(messageId);
              if (message) {
                const authorName =
                  message?.author?.split(":")[1] ||
                  message?._edits?.content?.by?.profile?.name ||
                  "Unknown";
                console.log(`✅ Found message: ${messageId}`);
                console.log(
                  `   Content: "${message.content?.substring(0, 100)}..."`,
                );
                console.log(`   Author: ${authorName}`);
              }
            } catch (error) {
              console.log(
                `⚠️  Found message ID ${messageId} but couldn't load details:`,
                error,
              );
            }
          }
        }
      }
    }

    console.log(`📝 Total unique messages found: ${messageIds.length}`);
    return messageIds;
  } catch (error) {
    console.error("❌ Search error:", error);
  }
}

// Test search for specific terms to see what's in the index
export async function testSearch(spaceId: string, term: string) {
  const results = await findMessages(spaceId, term);
  console.log(`Test search for "${term}" in space ${spaceId}:`, results);
  return results;
}

// Simple real-time indexing that monitors timeline changes
export async function indexNewMessages(
  spaceId: string,
  timeline: string[],
  channelId?: string,
  channelName?: string,
  threadId?: string,
  threadName?: string,
) {
  if (!search[spaceId] || !timeline?.length) return;

  const contextId = channelId || threadId;
  if (!contextId) return;

  // Get the last indexed message
  const lastIndexed = localStorage.getItem(`lastIndexedMessageId-${contextId}`);
  if (!lastIndexed) return;

  // Find new messages after the last indexed one
  const lastIndexedPos = timeline.indexOf(lastIndexed);
  if (lastIndexedPos === -1) return;

  const newMessages = timeline.slice(lastIndexedPos + 1);
  if (newMessages.length === 0) return;

  console.log(
    `Indexing ${newMessages.length} new messages in ${channelName || threadName}`,
  );

  // Index each new message sequentially to avoid race conditions
  for (const messageId of newMessages) {
    if (messageId) {
      try {
        await addMessageWithIndex(
          spaceId,
          messageId,
          channelId,
          channelName,
          threadId,
          threadName,
        );
        localStorage.setItem(`lastIndexedMessageId-${contextId}`, messageId);
      } catch (error) {
        console.error(`Failed to index message ${messageId}:`, error);
        // Don't update localStorage if indexing fails
        break;
      }
    }
  }
}

// Clear indexing progress for a space and force re-index
export async function resetAndReindex(spaceId: string) {
  console.log(`🔄 Resetting and re-indexing space: ${spaceId}`);

  try {
    // Load the space to get its channels
    const space = await Space.load(spaceId, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
        threads: {
          $each: true,
          $onError: null,
        },
      },
    });

    if (!space) {
      console.log("❌ Could not load space");
      return;
    }

    // Clear localStorage for all channels and threads
    let clearedCount = 0;

    // Clear channel indexing progress
    for (const c of space.channels ?? []) {
      if (!c) continue;
      const key = `lastIndexedMessageId-${c.id}`;
      if (localStorage.getItem(key)) {
        localStorage.removeItem(key);
        clearedCount++;
        console.log(`🗑️  Cleared indexing progress for channel: ${c.name}`);
      }
    }

    // Clear thread indexing progress
    for (const t of space.threads ?? []) {
      if (!t) continue;
      const key = `lastIndexedMessageId-${t.id}`;
      if (localStorage.getItem(key)) {
        localStorage.removeItem(key);
        clearedCount++;
        console.log(
          `🗑️  Cleared indexing progress for thread: ${t.name || t.id}`,
        );
      }
    }

    console.log(`🧹 Cleared ${clearedCount} indexing progress entries`);

    // Clear the search index to start fresh
    if (search[spaceId]) {
      search[spaceId] = null;
      console.log(`🗑️  Cleared search index for space`);
    }

    console.log(`🔄 Starting fresh indexing...`);

    // Re-initialize search
    await initSearch(space);

    console.log(`✅ Re-indexing completed!`);
  } catch (error) {
    console.error("❌ Error during reset and re-index:", error);
  }
}

// Diagnose indexing issues by checking the current space channels and messages
export async function diagnoseIndexing(spaceId: string) {
  console.log(`🔍 Diagnosing indexing for space: ${spaceId}`);

  try {
    // Load the space to see its structure
    const space = await Space.load(spaceId, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
      },
    });

    if (!space) {
      console.log("❌ Could not load space");
      return;
    }

    console.log(`📊 Space: ${space.name || spaceId}`);
    console.log(`📁 Channels found: ${space.channels?.length || 0}`);

    for (const c of space.channels ?? []) {
      if (!c) continue;

      console.log(`\n📝 Channel: ${c.name} (${c.channelType || "chat"})`);


      // Check last indexed message
      const lastIndexed = localStorage.getItem(`lastIndexedMessageId-${c.id}`);
      console.log(`   💾 Last indexed message: ${lastIndexed || "none"}`);

      // Try to load and inspect the channel
      try {
        const channel = await Channel.load(c.id, {
          resolve: {
            mainThread: {
              timeline: {
                $each: true,
                $onError: null,
              },
            },
          },
        });

        if (channel?.mainThread?.timeline) {
          const timeline = Object.values(
            channel.mainThread.timeline.perAccount ?? {},
          )
            .map((accountFeed) => new Array(...accountFeed.all))
            .flat()
            .filter((entry) => entry && entry.value)
            .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
            .map((a) => a.value)
            .filter((messageId) => messageId);

          console.log(`   📨 Total messages in timeline: ${timeline.length}`);

          // Show a few recent message IDs
          if (timeline.length > 0) {
            const recent = timeline.slice(-3);
            console.log(`   🆔 Recent message IDs:`, recent);

            // Try to load one recent message to see its content
            try {
              const recentMessage = await Message.load(
                recent[recent.length - 1],
              );
              if (recentMessage) {
                console.log(
                  `   📄 Recent message content: "${recentMessage.content?.substring(0, 100)}..."`,
                );
              }
            } catch (error) {
              console.log(`   ⚠️  Could not load recent message:`, error);
            }
          }
        } else {
          console.log("   ❌ No timeline found");
        }
      } catch (error) {
        console.log(`   ❌ Error loading channel: ${error}`);
      }
    }

    // Check search index status
    const hasIndex = search[spaceId];
    console.log(`\n🗂️  Search index exists: ${hasIndex ? "✅" : "❌"}`);
  } catch (error) {
    console.error("❌ Error during diagnosis:", error);
  }
}

export async function findMessages(spaceId: string, query: string) {
  let index = search[spaceId];
  if (!index) {
    console.log("No search index found for space:", spaceId);
    return [];
  }

  console.log("Searching for query:", query, "in space:", spaceId);

  try {
    const results = await index.search(query, {
      limit: 10,
      enrich: true,
    });

    console.log("Raw FlexSearch results:", results);

    let messages = [];

    if (Array.isArray(results)) {
      for (const fieldResult of results) {
        if (fieldResult && fieldResult.result) {
          for (const doc of fieldResult.result) {
            if (typeof doc === "string") {
              messages.push(doc);
            } else if (doc && doc.id) {
              messages.push(doc.id);
            }
          }
        }
      }
    }

    return [...new Set(messages)].slice(0, 10);
  } catch (error) {
    console.error("Search error:", error);
    return [];
  }
}
