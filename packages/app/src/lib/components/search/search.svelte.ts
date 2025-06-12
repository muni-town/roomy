import {
  Channel,
  Message,
  Thread,
  Timeline,
  type Space,
} from "$lib/jazz/schema";
import { Charset, Document, IndexedDB } from "flexsearch";
import type { co } from "jazz-tools";

let search: { [spaceId: string]: Document | null } = $state({});

export async function initSearch(space: co.loaded<typeof Space>) {
  if (!space) return;

  return;

  const db = new IndexedDB("roomy-search-index-" + space.id);

  search[space.id] = new Document({
    document: {
      id: "messageId",
      store: true,
      index: [
        {
          field: "username",
          tokenize: "forward",
          encoder: Charset.LatinBalance,
        },
        {
          field: "channelName",
          tokenize: "forward",
          encoder: Charset.LatinBalance,
        },
        {
          field: "messageContent",
          tokenize: "forward",
          encoder: Charset.LatinBalance,
        },
      ],
      tag: [
        {
          field: "threadId",
        },
        {
          field: "channelId",
        },
        {
          field: "username",
        },
      ],
    },
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

    // sort timeline
    let timeline = Object.values(channel.mainThread?.timeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value);

    // if we have an existing last indexed message id, start from there, otherwise start from the beginning
    let startIndex = lastIndexedMessageId
      ? timeline.indexOf(lastIndexedMessageId) + 1
      : 0;

    // console.log(
    //   "indexing channel",
    //   c.name,
    //   "from",
    //   startIndex,
    //   "to",
    //   timeline.length,
    // );

    // add messages to index
    for (let i = startIndex; i < timeline.length; i++) {
      const messageId = timeline[i];
      if (!messageId) continue;

      await addMessageWithIndex(space.id, messageId, c.id, c.name);

      // update last indexed message id for channel
      localStorage.setItem(`lastIndexedMessageId-${c.id}`, messageId);
    }

    //console.log("subscribing to channel", c.id);
    Timeline.subscribe(channel.mainThread?.id, (message) => {
      //console.log("new message in channel", c.name, c.id, message.id);
      addMessageWithIndex(space.id, message.id, c.id, c.name);
    });
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

    // sort timeline
    let timeline = Object.values(thread.timeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value);

    // if we have an existing last indexed message id, start from there, otherwise start from the beginning
    let startIndex = lastIndexedMessageId
      ? timeline.indexOf(lastIndexedMessageId) + 1
      : 0;

    // console.log(
    //   "indexing thread",
    //   t.id,
    //   "from",
    //   startIndex,
    //   "to",
    //   timeline.length,
    // );

    // add messages to index
    for (let i = startIndex; i < timeline.length; i++) {
      const messageId = timeline[i];
      if (!messageId) continue;

      await addMessageWithIndex(space.id, messageId, t.id, t.name);

      // update last indexed message id for thread
      localStorage.setItem(`lastIndexedMessageId-${t.id}`, messageId);
    }

    //console.log("subscribing to thread", t.id);
    // once we have indexed all messages, subscribe to new messages
    Timeline.subscribe(thread.id, (message) => {
      //console.log("new message in thread", t.name, t.id, message.id);
      addMessageWithIndex(space.id, message.id, t.id, t.name);
    });
  }
}

export async function addMessageWithIndex(
  spaceId: string,
  messageId: string,
  channelId?: string,
  channelName?: string,
  threadId?: string,
  threadName?: string,
) {
  // load message
  const message = await Message.load(messageId);
  if (!message) return;

  // add message to index
  addMessage(spaceId, {
    messageId: message.id,
    messageContent: message.content,
    channelName: channelName,
    channelId: channelId,
    threadName: threadName,
    threadId: threadId,
    username: message?._edits.content?.by?.profile?.name ?? "",
    userId: message?._edits.content?.by?.profile?.id ?? "",
  });
}

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
  //console.log("adding to index", spaceId, messageData.messageId);
  search[spaceId].add(messageData.messageId, messageData);
}

export async function findMessages(spaceId: string, query: string) {
  let index = search[spaceId];
  if (!index) {
    //console.log("no index for space", spaceId);
    return [];
  }
  //console.log("searching for", query, "in space", spaceId);
  const results = await index.search({
    query,
    limit: 10,
    merge: true,
  });
  //console.log("results", results);
  let messages = [];
  for (const result of results) {
    messages.push(result.id);
  }
  //console.log("found messages", messages);
  return messages;
}
