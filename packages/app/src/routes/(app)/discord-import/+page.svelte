<script lang="ts">
  import { globalState } from "$lib/global.svelte";
  import * as zip from "@zip-js/zip-js";
  // import {
  //   Channel,
  //   Message as RoomyMessage,
  //   Space,
  //   Thread,
  //   Category,
  //   type EntityIdStr,
  // } from "@roomy-chat/sdk";
  import { marked } from "marked";
  import { navigate } from "$lib/utils.svelte";
  import toast from "svelte-french-toast";

  let archiveInput = $state(undefined) as FileList | undefined;
  let loading = $state(false);
  // Add progress tracking variables
  let totalEntries = $state(0);
  let currentEntryNum = $state(0);
  let currentEntityName = $state("");
  let messageCount = $state(0);
  let processedMessages = $state(0);
  // Add import completion state
  let importComplete = $state(false);
  let importedSpaceId = $state("");
  let importedSpaceName = $state("");

  import { user } from "$lib/user.svelte";
  import { onMount } from "svelte";

  type DiscordMessage<
    MessageType extends "Default" | "Reply" | string = "Default",
  > = {
    id: string;
    type: MessageType;
    timestamp: string;
    timestampEdited: string | null;
    callEndedTimestamp: string | null;
    isPinned: boolean;
    content: string;
    author: ImportAuthor;
    attachments: any[];
    embeds: {
      title: string;
      url: string;
      timestamp: string | null;
      description: string;
      color: string;
      thumbnail: {
        url: string;
        width: number;
        height: number;
      };
      images: any[];
      fields: any[];
      inlineEmojis: ImportEmoji[];
    }[];
    stickers: any[];
    reactions: ImportEmoji[];
    mentions: ImportAuthor[];
    reference: MessageType extends "Reply"
      ? {
          messageId: string;
          channelId: string;
          guildId: string;
        }
      : never;
    inlineEmojis: any[];
  };

  type ImportAuthor = {
    id: string;
    name: string;
    discriminator: string;
    nickname: string;
    color: string;
    isBot: boolean;
    roles: {
      id: string;
      name: string;
      color: string;
      position: number;
    };
    avatarUrl: string;
  };
  type ImportEmoji = {
    id: string;
    name: string;
    code: string;
    isAnimated: boolean;
    imageUrl: string;
  };
  type ImportChannel = {
    guild: {
      id: string;
      name: string;
      iconUrl: string;
    };
    channel: {
      id: string;
      type: string;
      categoryId: string;
      category: string;
      name: string;
      topic: string;
    };
    expotedAt: string;
    messages: DiscordMessage<any>[];
    messageCount: number;
  };

  onMount(() => {
    user.init();
  });

  // Helper function to convert markdown to TipTap JSON format
  function markdownToTipTap(markdown: string): any {
    if (!markdown || markdown.trim() === "") {
      return {
        type: "doc",
        content: [{ type: "paragraph" }],
      };
    }

    // Parse the markdown
    const tokens = marked.lexer(markdown);
    const content: any[] = [];

    // Process tokens and convert to TipTap format
    for (const token of tokens) {
      if (token.type === "paragraph") {
        content.push({
          type: "paragraph",
          content: processInlineTokens(token.tokens || []),
        });
      } else if (token.type === "heading") {
        content.push({
          type: "heading",
          attrs: { level: token.depth },
          content: processInlineTokens(token.tokens || []),
        });
      } else if (token.type === "code") {
        content.push({
          type: "codeBlock",
          attrs: { language: token.lang || "text" },
          content: [{ type: "text", text: token.text }],
        });
      } else if (token.type === "blockquote") {
        content.push({
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: processInlineTokens(token.tokens || []),
            },
          ],
        });
      } else if (token.type === "list") {
        content.push({
          type: token.ordered ? "orderedList" : "bulletList",
          content: token.items.map((item: any) => ({
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: processInlineTokens(item.tokens || []),
              },
            ],
          })),
        });
      } else if (token.type === "hr") {
        content.push({ type: "horizontalRule" });
      }
    }

    return {
      type: "doc",
      content: content.length ? content : [{ type: "paragraph" }],
    };
  }

  function processInlineTokens(tokens: any[]): any[] {
    if (!tokens || !tokens.length) {
      return [{ type: "text", text: "" }];
    }

    const result: any[] = [];

    for (const token of tokens) {
      if (token.type === "text") {
        result.push({ type: "text", text: token.text });
      } else if (token.type === "strong") {
        result.push({
          type: "bold",
          content: processInlineTokens(token.tokens || []),
        });
      } else if (token.type === "em") {
        result.push({
          type: "italic",
          content: processInlineTokens(token.tokens || []),
        });
      } else if (token.type === "codespan") {
        result.push({
          type: "code",
          content: [{ type: "text", text: token.text }],
        });
      } else if (token.type === "link") {
        result.push({
          type: "link",
          attrs: { href: token.href },
          content: [{ type: "text", text: token.text }],
        });
      } else if (token.tokens) {
        // Process any nested tokens
        result.push(...processInlineTokens(token.tokens));
      } else {
        // Fallback for any other token types
        result.push({ type: "text", text: token.raw || "" });
      }
    }

    return result;
  }

  async function importArchive() {
    if (!globalState.roomy) return;

    importComplete = false;
    importedSpaceId = "";
    importedSpaceName = "";
    loading = true;
    if (!archiveInput) return;
    const file = archiveInput.item(0);
    if (!file) return;

    const reader = new zip.ZipReader(new zip.BlobReader(file));

    const entries = await reader.getEntries();
    totalEntries = entries.filter((entry) => entry.getData).length;

    console.log("Starting import");

    const space = await globalState.roomy.create(Space);
    space.admins((x) => user.agent && x.push(user.agent.assertDid));

    globalState.roomy.spaces.push(space);
    globalState.roomy.commit();

    importedSpaceId = space.id;

    let channelNum = 0;
    const existingCategories: Category[] = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (!entry.getData) continue;
      channelNum += 1;
      currentEntryNum = channelNum;

      const dataWriter = new zip.BlobWriter("application/json");
      await entry.getData(dataWriter);
      const data = new Uint8Array(
        await (await dataWriter.getData()).arrayBuffer(),
      );
      if (data.length == 0) continue;

      const parsed: ImportChannel = JSON.parse(new TextDecoder().decode(data));
      currentEntityName = parsed.channel.name;
      messageCount = parsed.messageCount;
      processedMessages = 0;

      if (
        existingCategories.filter((x) => x.name == parsed.channel.category)
          .length == 0 &&
        parsed.channel.type === "GuildTextChat"
      ) {
        const category = await globalState.roomy.create(Category);
        category.name = parsed.channel.category;
        category.appendAdminsFrom(space);
        space.sidebarItems.push(category);
        existingCategories.push(category);
        category.commit();
        space.commit();
      }

      let messages: { [id: string]: EntityIdStr } = {};

      if (!importedSpaceName && parsed.guild && parsed.guild.name) {
        importedSpaceName = parsed.guild.name;
        space.name = importedSpaceName;
        space.commit();
      }

      switch (parsed.channel.type) {
        case "GuildPublicThread":
          const thread = await globalState.roomy.create(Thread);

          space.threads.push(thread);
          space.sidebarItems.push(thread);
          space.commit();

          console.log("Importing thread: ", parsed.channel.name);

          thread.name = parsed.channel.name;
          thread.description = parsed.channel.topic;

          for (const [i, parsedMessage] of Array.from(
            { length: parsed.messages.length },
            (_, i) => [i, parsed.messages[i] as DiscordMessage<any>] as const,
          )) {
            processedMessages = i + 1;
            if (i % 100 == 0) {
              console.log(
                `importing thread: ${thread.name} ( ${channelNum} )
                importing message number: ${i} / ${parsed.messageCount}`,
              );
              thread.commit();
            }

            const message = await globalState.roomy.create(RoomyMessage);
            thread.timeline.push(message);

            // Process markdown content into TipTap JSON format
            message.bodyJson = JSON.stringify(
              markdownToTipTap(parsedMessage.content || ""),
            );

            // Handle reply messages
            if (parsedMessage.type === "Reply" && parsedMessage.reference) {
              const replyingToMessageId = parsedMessage.reference.messageId;
              if (messages[replyingToMessageId]) {
                message.replyTo = messages[replyingToMessageId];
              }
            }

            message.authors((x) =>
              x.push(
                `discord:${parsedMessage.author.nickname}:${encodeURIComponent(parsedMessage.author.avatarUrl)}`,
              ),
            );
            message.commit();
            // Store message reference
            messages[parsedMessage.id] = message.id;
            await globalState.roomy.peer.close(message.id);
          }
          console.log("committing thread");
          thread.commit();
          await globalState.roomy.peer.close(thread.id);
          break;

        case "GuildTextChat":
        default:
          const channel = await globalState.roomy.create(Channel);

          space.name = parsed.guild.name;
          space.channels.push(channel);

          existingCategories
            .filter((x) => x.name == parsed.channel.category)[0]
            ?.channels.push(channel);
          existingCategories
            .filter((x) => x.name == parsed.channel.category)[0]
            ?.commit();
          space.commit();

          console.log("Importing channel: ", parsed.channel.name);

          channel.name = parsed.channel.name;
          channel.description = parsed.channel.topic;

          for (const [i, parsedMessage] of Array.from(
            { length: parsed.messages.length },
            (_, i) => [i, parsed.messages[i] as DiscordMessage<any>] as const,
          )) {
            processedMessages = i + 1;
            if (i % 100 == 0) {
              console.log(
                `importing channel: ${channel.name} ( ${channelNum} )
    importing message number: ${i} / ${parsed.messageCount}`,
              );
              channel.commit();
            }

            const message = await globalState.roomy.create(RoomyMessage);
            channel.timeline.push(message);

            // Process markdown content into TipTap JSON format
            message.bodyJson = JSON.stringify(
              markdownToTipTap(parsedMessage.content || ""),
            );

            // Handle reply messages
            if (parsedMessage.type === "Reply" && parsedMessage.reference) {
              const replyingToMessageId = parsedMessage.reference.messageId;
              if (messages[replyingToMessageId]) {
                message.replyTo = messages[replyingToMessageId];
              }
            }

            message.authors((x) =>
              x.push(
                `discord:${parsedMessage.author.nickname}:${encodeURIComponent(parsedMessage.author.avatarUrl)}`,
              ),
            );

            message.commit();
            messages[parsedMessage.id] = message.id;
            await globalState.roomy.peer.close(message.id);
          }

          console.log("committing channel");
          channel.commit();
          await globalState.roomy.peer.close(channel.id);
          break;
      }
      space.commit();
    }

    loading = false;
    importComplete = true;
    archiveInput = undefined;

    toast.success(
      `Successfully imported ${importedSpaceName || "Discord data"}!`,
      {
        position: "bottom-end",
        duration: 5000,
      },
    );
  }

  function goToImportedSpace() {
    navigate({ space: importedSpaceId });
  }
</script>

<form
  class="m-auto flex flex-col gap-6 p-4 text-center"
  onsubmit={importArchive}
>
  <h1 class="text-3xl font-bold">Discord Import</h1>

  <p>
    Select a <a href="https://github.com/Tyrrrz/DiscordChatExporter"
      >Discord Chat Exporter</a
    > zip archive to import it to a Roomy space.
  </p>

  <input
    type="file"
    class="dz-file-input w-full"
    id="archive"
    name="Archive"
    accept="application/zip"
    bind:files={archiveInput}
  />

  {#if loading}
    <div class="flex flex-col gap-3 bg-base-200 p-4 rounded-lg">
      <h3 class="text-xl font-semibold">Importing Discord Data</h3>

      <div class="flex flex-col gap-2">
        <div class="flex justify-between text-sm">
          <span>Processing channels: {currentEntryNum} of {totalEntries}</span>
          <span>{Math.round((currentEntryNum / totalEntries) * 100)}%</span>
        </div>
        <progress
          class="progress progress-primary"
          value={currentEntryNum}
          max={totalEntries}
        ></progress>
      </div>

      {#if currentEntityName}
        <div class="flex flex-col gap-2">
          <div class="flex justify-between text-sm">
            <span>Current channel: {currentEntityName}</span>
            <span>{processedMessages} of {messageCount} messages</span>
          </div>
          <progress
            class="progress progress-secondary"
            value={processedMessages}
            max={messageCount}
          ></progress>
        </div>
      {/if}
    </div>
  {:else if importComplete}
    <div class="alert alert-success">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="stroke-current shrink-0 h-6 w-6"
        fill="none"
        viewBox="0 0 24 24"
        ><path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        /></svg
      >
      <div class="flex flex-col items-start">
        <span
          >Import complete! {importedSpaceName
            ? `"${importedSpaceName}" has been created.`
            : "Space has been created."}</span
        >
        <button
          type="button"
          class="dz-btn dz-btn-sm dz-btn-primary mt-2"
          onclick={goToImportedSpace}
        >
          Go to Space
        </button>
      </div>
    </div>
  {/if}

  <button
    class="dz-btn dz-btn-primary"
    disabled={loading || !archiveInput || importComplete}
    >{loading ? "Importing..." : "Import Space"}</button
  >
</form>
