<script lang="ts">
  import { Button, toast } from "@fuxui/base";
  import { Slider } from "@fuxui/base";
  import { Stopwatch, StopwatchState } from "@fuxui/time";
  import { launchConfetti } from "@fuxui/visual";
  import * as types from "./types";

  import * as zip from "@zip-js/zip-js";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries.svelte";
  import { ulid } from "ulidx";
  import type { EventType } from "$lib/workers/materializer";

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
    if (!current.space) return;
    const file = files?.item(0);
    if (!file) {
      toast.error("Please select a file to import.", { position: "top-right" });
      return;
    }
    importing = true;
    stopwatch.start();

    const batchSize = 500;
    let batch: EventType[] = [];
    let batchMessageCount = 0;

    try {
      const reader = new zip.ZipReader(new zip.BlobReader(file));

      const entries = await reader.getEntries();
      channelCount = entries.length;

      for (const entry of entries) {
        if (!entry.getData) continue;
        const dataWriter = new zip.BlobWriter("application/json");
        await entry.getData(dataWriter);
        const data = new Uint8Array(
          await (await dataWriter.getData()).arrayBuffer(),
        );
        if (data.length == 0) continue;
        const channel: types.ImportChannel = JSON.parse(
          new TextDecoder().decode(data),
        );

        messageCount = channel.messageCount;

        const channelId = ulid();
        batch.push({
          ulid: channelId,
          parent: undefined,
          variant: {
            kind: "space.roomy.room.create.0",
            data: undefined,
          },
        });
        batch.push({
          ulid: ulid(),
          parent: channelId,
          variant: {
            kind: "space.roomy.info.0",
            data: {
              name: {
                tag: "set",
                value: channel.channel.name,
              },
              avatar: { tag: "ignore", value: undefined },
              description: { tag: "set", value: channel.channel.topic },
            },
          },
        });
        batch.push({
          ulid: ulid(),
          parent: channelId,
          variant: {
            kind: "space.roomy.channel.mark.0",
            data: undefined,
          },
        });

        for (const message of channel.messages) {
          const messageId = ulid();
          batch.push({
            ulid: messageId,
            parent: channelId,
            variant: {
              kind: "space.roomy.message.create.0",
              data: {
                content: {
                  mimeType: "text/markdown",
                  content: new TextEncoder().encode(message.content),
                },
                replyTo: undefined,
              },
            },
          });
          batch.push({
            ulid: ulid(),
            parent: messageId,
            variant: {
              kind: "space.roomy.message.overrideMeta.0",
              data: {
                source: `discord:message?guild=${channel.guild.id}&channel=${channel.channel.id}&id=${message.id}`,
                author: `discord:user?id=${message.author.id}`,
                timestamp: BigInt(
                  Math.round(new Date(message.timestamp).getTime() / 100),
                ),
              },
            },
          });

          batchMessageCount += 1;

          if (batch.length >= batchSize) {
            await backend.sendEventBatch(current.space.id, batch);
            finishedMessages.value += batchMessageCount;
            batch = [];
            batchMessageCount = 0;
          }
        }

        finishedChannels.value += 1;
        finishedMessages.value = 0;
      }

      await backend.sendEventBatch(current.space.id, batch);

      launchConfetti();
      importFinished = true;
      stopwatch.stop();
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
    <h1 class="text-2xl font-bold text-center">Importing</h1>

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
