<script lang="ts">
  import { Button, Input, toast } from "@fuxui/base";
  import { Slider } from "@fuxui/base";
  import { Stopwatch, StopwatchState } from "@fuxui/time";
  import { launchConfetti } from "@fuxui/visual";
  import * as types from "./types";

  import * as zip from "@zip-js/zip-js";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries";
  import { sql } from "$lib/utils/sqlTemplate";
  import { formatDate } from "date-fns";
  import {
    ulidFactory,
    UserDid,
    type Event,
    type Ulid,
    toBytes,
  } from "@roomy/sdk";

  const currentSpaceId = $derived(current.joinedSpace?.id);

  let cutoffDateInput = $state("");
  let cutoffDate = $derived.by(() => {
    if (!cutoffDateInput) return;
    const parsed = new Date(cutoffDateInput);
    if (isNaN(parsed.getTime())) return;
    return parsed;
  });
  let files = $state(undefined) as FileList | undefined;

  let guildProgress = $state(0);
  let channelProgress = $state(0);
  let currentChannelImportingName = $state("");
  let stopwatch: StopwatchState = $state(new StopwatchState({ precision: 2 }));
  let importing = $state(false);
  let importFinished = $state(false);
  let channelCount = $state(0);
  let finishedChannels = {
    c: 0,
    get value() {
      return this.c;
    },
    set value(v) {
      this.c = v;
      guildProgress = (this.c / channelCount) * 100;
    },
  };
  let messageCount = $state(0);
  let finishedMessages = {
    c: 0,
    get value() {
      return this.c;
    },
    set value(v) {
      this.c = v;
      channelProgress = (this.c / messageCount) * 100;
    },
  };

  async function importZip() {
    const makeUlid = ulidFactory();

    const spaceId = currentSpaceId;
    if (!spaceId) return;
    const file = files?.item(0);
    if (!file) {
      toast.error("Please select a file to import.", { position: "top-right" });
      return;
    }
    importing = true;
    stopwatch.start();

    const batchSize = 2500;
    let batch: Event[] = [];
    let batchMessageCount = 0;

    await backend.pauseSubscription(spaceId);

    const existingDiscordUsers = new Set();

    const existingInDb = await backend.runQuery<{ did: string }>(
      sql`select did as did from comp_user where did like 'did:discord:%';`,
    );
    for (const row of existingInDb.rows || []) {
      existingDiscordUsers.add(row.did);
    }

    try {
      const reader = new zip.ZipReader(new zip.BlobReader(file));

      const entries = (
        await Promise.all(
          (await reader.getEntries()).map(async (entry) => {
            if (!entry.getData) return undefined;
            const dataWriter = new zip.BlobWriter("application/json");
            await entry.getData(dataWriter);
            const data = new Uint8Array(
              await (await dataWriter.getData()).arrayBuffer(),
            );
            if (data.length == 0) return undefined;
            const channel: types.ImportChannel = JSON.parse(
              new TextDecoder().decode(data),
            );
            return channel;
          }),
        )
      ).filter((x) => !!x) as types.ImportChannel[];
      channelCount = entries.length;

      // Create all the threads and channels up-front
      const rooms: Map<
        string,
        {
          kind:
            | "space.roomy.category"
            | "space.roomy.channel"
            | "space.roomy.thread";
          name: string;
          discordParentId?: string;
          topic?: string;
          roomyId: Ulid;
        }
      > = new Map();

      for (const entry of entries) {
        const parentInfo = rooms.get(entry.channel.categoryId);
        if (!parentInfo) {
          rooms.set(entry.channel.categoryId, {
            kind:
              entry.channel.type == "GuildPublicThread"
                ? "space.roomy.channel"
                : "space.roomy.category",
            name: entry.channel.category,
            roomyId: makeUlid(),
          });
        }

        const existingChannelInfo = rooms.get(entry.channel.id);
        rooms.set(entry.channel.id, {
          discordParentId: entry.channel.categoryId,
          kind:
            entry.channel.type == "GuildPublicThread"
              ? "space.roomy.thread"
              : "space.roomy.channel",
          name: entry.channel.name,
          roomyId: existingChannelInfo?.roomyId || makeUlid(),
          topic: entry.channel.topic,
        });
      }

      for (const _room of rooms.values()) {
        throw new Error("TODO: need to setup sidebar properly");
        // const roomyParentId = room.discordParentId
        //   ? rooms.get(room.discordParentId)?.roomyId
        //   : undefined;
        // batch.push({
        //   id: room.roomyId,
        //   room: roomyParentId,
        //   $type: "space.roomy.room.createRoom.v0",
        //   kind:
        //     room.kind == "space.roomy.category"
        //       ? "space.roomy.category"
        //       : room.kind == "space.roomy.channel"
        //         ? "space.roomy.channel"
        //         : "space.roomy.thread",
        //   name: room.name,
        // });
      }

      for (const channel of entries) {
        currentChannelImportingName = channel.channel.name;
        messageCount = channel.messageCount;

        let roomId = rooms.get(channel.channel.id)?.roomyId;
        if (!roomId) return;

        for (const message of channel.messages) {
          if (
            cutoffDate &&
            new Date(message.timestamp).getTime() < cutoffDate.getTime()
          ) {
            continue;
          }

          const author = UserDid.assert(`did:discord:${message.author.id}`);

          const messageId = makeUlid();
          batch.push({
            id: messageId,
            room: roomId,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: "text/markdown",
              data: toBytes(new TextEncoder().encode(message.content)),
            },
            extensions: {
              "space.roomy.extension.authorOverride.v0": {
                did: author,
              },
              "space.roomy.extension.timestampOverride.v0": {
                timestamp: Math.round(new Date(message.timestamp).getTime()),
              },
            },
          });

          for (const reaction of message.reactions) {
            for (const user of reaction.users) {
              batch.push({
                id: makeUlid(),
                room: roomId,
                $type: "space.roomy.reaction.addBridgedReaction.v0",
                reaction: reaction.emoji.name,
                reactingUser: UserDid.assert(`did:discord:${user.id}`),
                reactionTo: messageId,
              });
            }
          }

          const authorAvatarUrl = message.author.avatarUrl;
          const avatarPathSegments = new URL(authorAvatarUrl).pathname.split(
            "/",
          );
          const avatarHash = avatarPathSegments[avatarPathSegments.length - 1];

          if (!existingDiscordUsers.has(author)) {
            batch.push({
              id: makeUlid(),
              $type: "space.roomy.user.updateProfile.v0",
              did: author,
              name: message.author.nickname,
              avatar: `https://cdn.discordapp.com/avatars/${message.author.id}/${avatarHash}?size=64`,
            });
            batch.push({
              id: makeUlid(),
              $type: "space.roomy.user.overrideHandle.v0",
              did: author,
              handle: message.author.name,
            });
            existingDiscordUsers.add(author);
          }

          batchMessageCount += 1;

          if (batch.length >= batchSize) {
            try {
              await backend.sendEventBatch(spaceId, batch);
            } catch (e) {
              console.error(e);
              throw new Error("Error sending batch");
            }
            finishedMessages.value += batchMessageCount;
            batch = [];
            batchMessageCount = 0;
          }
        }

        finishedChannels.value += 1;
        finishedMessages.value = 0;
      }

      await backend.sendEventBatch(spaceId, batch);

      launchConfetti();
      importFinished = true;
      stopwatch.stop();

      await backend.unpauseSubscription(spaceId);
    } catch (e) {
      console.error(e);
      toast.error(`Error while importing Discord archive: ${e}`, {
        position: "top-right",
      });
    } finally {
      importing = false;
    }
  }
</script>

<form class="pt-4">
  <div class="space-y-12">
    <h2 class="text-xl/7 font-semibold text-base-900 dark:text-base-100">
      Discord Import
    </h2>

    <p>Import a Discord zip archive into your Roomy space.</p>

    <label class="flex flex-col gap-2">
      Cutoff date:
      <Input bind:value={cutoffDateInput} placeholder="Jan 10 2020" />
      {#if cutoffDate != undefined}
        <span class="text-sm"
          >Messages older than {formatDate(cutoffDate, "MMM dd, yyyy")} will not
          be imported.</span
        >
      {:else}
        <span class="text-sm"
          >Optionally specify a date and messages older than that will not be
          imported.</span
        >
      {/if}
    </label>

    <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <label
        class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
      >
        Zip Archive
        <input type="file" accept="zip" bind:files />
      </label>
    </div>
  </div>

  <div class="mt-6 flex items-center justify-end gap-x-6">
    <div>
      <Button type="button" disabled={importing} onclick={importZip}>
        Import
      </Button>
    </div>
  </div>
</form>

{#if importing || importFinished}
  <div class="flex flex-col items-stretch mt-4 gap-3">
    <h1 class="text-2xl font-bold text-center">
      {importFinished ? "Done! 🎉" : "Importing"}
    </h1>

    <Stopwatch bind:stopwatch />

    <div class="text-center">
      Guild Import Progress {guildProgress}% {finishedChannels.value}/{channelCount}
    </div>
    <Slider type="single" bind:value={guildProgress} />

    <div class="text-center">
      Channel ( {currentChannelImportingName} ) Import Progress {channelProgress}%
      {finishedMessages.value}/{messageCount}
    </div>
    <Slider type="single" bind:value={channelProgress} />
  </div>
{/if}
