import { getProfile } from "$lib/profile.svelte";
import { createCompleteExtensions } from "$lib/tiptap/editor";
import { Message, Category } from "@roomy-chat/sdk";
import { generateHTML } from "@tiptap/html";
import TurndownService from "turndown";
import * as zip from "@zip-js/zip-js";

const extensions = [
  ...createCompleteExtensions({ users: [], context: [], includeImage: true }),
];

const model = (() => {
  let zipWriter: any | null = null;
  return {
    addFile(name: string, content: string) {
      if (!zipWriter) {
        zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"), {
          bufferedWrite: true,
        });
      }
      return zipWriter.add(name, new zip.TextReader(content));
    },
    async getBlobURL() {
      if (zipWriter) {
        const blobURL = URL.createObjectURL(await zipWriter.close());
        zipWriter = null;
        return blobURL;
      } else {
        throw new Error("Zip file closed");
      }
    },
  };
})();

export async function export_space(space: any, account: any) {
  if (!space) {
    console.error("Space not found");
    return;
  }
  if (!account) {
    console.error("Account not found");
    return;
  }
  const space_name = space.name;
  console.log(space_name);

  const allCategories: { name: string; id: string; channels: Set<string> }[] =
    [];

  const categories = await space.sidebarItems.items();
  for (let c of categories) {
    const category = c.tryCast(Category);
    if (!category) continue;
    console.log(category);
    const channels = await category.channels.items();
    const category_channels = new Set<string>();
    for (let channel of channels) {
      console.log(channel);
      category_channels.add(channel.id);
    }
    allCategories.push({
      name: category.name,
      id: category.id,
      channels: category_channels,
    });
  }

  let space_icon = null;
  if (space.image) {
    // TODO: Fix Image type - temporarily disabled
    // const image = await account.open(Image, space.image);
    // space_icon = image.uri;
  }

  const threads = await space.threads.items();

  let files = [];

  for (let thread of threads) {
    const thread_name = thread.name;
    const timeline = await thread.timeline.items();
    const messages = await export_timeline(timeline, thread.id, space.id);

    files.push({
      guild: {
        id: space.id,
        name: space.name,
        iconUrl: space_icon,
      },
      channel: {
        id: thread.id,
        type: "GuildPublicThread",
        name: thread_name,
      },
      messages: messages,
      exportedAt: new Date().toISOString(),
    });
  }

  const channels = await space.channels.items();
  for (let channel of channels) {
    const channel_name = channel.name;
    console.log(channel_name);

    const timeline = await channel.timeline.items();
    const messages = await export_timeline(timeline, channel.id, space.id);

    const category = allCategories.find((c) => c.channels.has(channel.id));

    files.push({
      guild: {
        id: space.id,
        name: space.name,
        iconUrl: space_icon,
      },
      channel: {
        id: channel.id,
        type: "GuildTextChat",
        name: channel_name,
        category: category?.name,
        categoryId: category?.id,
      },
      messages: messages,
      exportedAt: new Date().toISOString(),
    });
  }

  for (let file of files) {
    model.addFile(
      file.channel.type + "-" + file.channel.name + ".json",
      JSON.stringify(file, null, 2),
    );
  }

  const blobURL = await model.getBlobURL();
  const a = document.createElement("a");
  a.href = blobURL;
  a.download = "export-" + space_name + "-" + new Date().toISOString() + ".zip";
  a.click();
}

async function export_timeline(
  timeline: any[],
  channelId: string,
  guildId: string,
) {
  const messages = [];
  for (let item of timeline) {
    if (!item) continue;
    const message = item.tryCast(Message);
    if (!message) continue;
    const markdown = export_message(message);
    const author = message.authors((x) => x.get(0));
    const profile = await getProfile(author);

    const messageObject: any = {
      id: message.id,
      content: markdown,
      timestamp: message.createdDate,
      timestampEdited: message.updatedDate,
      author: {
        id: profile.did,
        name: profile.handle,
        nickname: profile.handle,
        avatarUrl: profile.avatarUrl,
      },
    };

    if (message.replyTo) {
      messageObject.type = "Reply";
      messageObject.reference = {
        messageId: message.replyTo,
        channelId: channelId,
        guildId: guildId,
      };
    }

    messages.push(messageObject);
  }
  return messages;
}

function export_message(message: Message) {
  try {
    const json = JSON.parse(message.bodyJson);
    const content = generateHTML(json, extensions);

    var turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
    });
    const markdown = turndownService.turndown(content);

    return markdown;
  } catch (e) {
    console.error(e);
    return "";
  }
}
