<script lang="ts">
  import * as zip from "@zip-js/zip-js";
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
  import {
    createCategory,
    createChannel,
    createMessage,
    createSpace,
    createThread,
    RoomyAccount,
    SpaceMigrationReference,
    spaceMigrationReferenceId,
  } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-tools/svelte";

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

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  async function markdownToHTML(markdown: string): Promise<any> {
    let html = await marked.parse(markdown);
    return html;
  }

  async function importArchive() {
    if (!me.current?.profile.joinedSpaces) {
      console.error("No joined spaces");
      return;
    }
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

    const space = createSpace("Imported Space", undefined, false);

    me.current.profile.joinedSpaces.push(space);

    importedSpaceId = space.id;

    let channelNum = 0;

    let oldSpaceId = "";

    let totalMessages = 0;
    const existingCategories: Record<string, any> = {};
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

      let parsed: ImportChannel;
      try {
        parsed = JSON.parse(new TextDecoder().decode(data));
      } catch (e) {
        console.error("Error parsing JSON: ", e);
        continue;
      }

      currentEntityName = parsed.channel.name;
      messageCount = parsed.messageCount;
      processedMessages = 0;

      if (!oldSpaceId) {
        oldSpaceId = parsed.guild.id;
      }

      if (
        parsed.channel.type === "GuildTextChat" &&
        parsed.channel.category &&
        !existingCategories[parsed.channel.category]
      ) {
        const category = createCategory(parsed.channel.category);
        existingCategories[parsed.channel.category] = category;

        space.categories.push(category);
      }

      let messages: { [id: string]: string } = {};

      if (!importedSpaceName && parsed.guild?.name) {
        importedSpaceName = parsed.guild.name;
        space.name = importedSpaceName;
      }

      let timeline = null;
      let name = null;
      let type = null;

      console.log("Importing: ", parsed.channel.type, parsed.channel.name);
      switch (parsed.channel.type) {
        case "GuildPublicThread":
          const thread = createThread([], parsed.channel.name);
          space.threads.push(thread);

          console.log("Importing thread: ", parsed.channel.name);

          thread.name = parsed.channel.name;
          // thread.description = parsed.channel.topic;
          timeline = thread.timeline;
          type = "space.roomy.thread";
          name = thread.name;
          break;

        case "GuildTextChat":
          const channel = createChannel(parsed.channel.name);

          space.name = parsed.guild.name;
          space.channels.push(channel);

          existingCategories[parsed.channel.category]?.channels.push(channel);

          console.log("Importing channel: ", parsed.channel.name);

          channel.name = parsed.channel.name;

          timeline = channel.mainThread.timeline;
          // channel.description = parsed.channel.topic;
          type = "space.roomy.channel";
          name = channel.name;
          break;
      }

      console.log("Timeline: ", timeline);
      if (timeline) {
        for (const [i, parsedMessage] of Array.from(
          { length: parsed.messages.length },
          (_, i) => [i, parsed.messages[i] as DiscordMessage<any>] as const,
        )) {
          processedMessages = i + 1;
          totalMessages += 1;
          if (i % 100 == 0) {
            console.log(
              `importing ${type}: ${name} ( ${channelNum} )
    importing message number: ${i} / ${parsed.messageCount}`,
            );

            console.log("Total messages: ", totalMessages);
          }

          await new Promise((resolve) => setTimeout(resolve, 20));

          const html = await markdownToHTML(parsedMessage.content || "");

          const message = createMessage(html);
          timeline.push(message.id);

          // Handle reply messages
          if (parsedMessage.type === "Reply" && parsedMessage.reference) {
            const replyingToMessageId = parsedMessage.reference.messageId;
            if (messages[replyingToMessageId]) {
              message.replyTo = messages[replyingToMessageId];
            }
          }
          message.createdAt = new Date(parsedMessage.timestamp);
          if (parsedMessage.timestampEdited) {
            message.updatedAt = new Date(parsedMessage.timestampEdited);
          } else {
            message.updatedAt = message.createdAt;
          }

          message.author = `discord:${parsedMessage.author.nickname}:${encodeURIComponent(parsedMessage.author.avatarUrl)}`;
          messages[parsedMessage.id] = message.id;
        }
      }
    }

    loading = false;
    importComplete = true;
    archiveInput = undefined;

    console.log("importedSpaceId", importedSpaceId);
    // load reference
    if (oldSpaceId.startsWith("leaf:")) {
      console.log("loading reference", oldSpaceId, space.id);
      const reference = await SpaceMigrationReference.load(
        spaceMigrationReferenceId,
      );
      console.log("loaded reference", reference);
      if (reference) {
        reference[oldSpaceId] = space.id;
        console.log("set reference", reference);
      }
    }

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
  <h1 class="text-3xl font-bold">Import Space</h1>

  <p>
    Select the exported zip archive of an old Roomy space to import it to a new
    Roomy space.
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
          class="dz-btn dz-btn-primary dz-btn-lg mt-2"
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
