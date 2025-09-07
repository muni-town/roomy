<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { onMount, untrack } from "svelte";
  import { Input, Button, Textarea } from "@fuxui/base";
  import * as zip from "@zip-js/zip-js";
  import * as types from "./discordTypes";
  import { LeafClient } from "@muni-town/leaf-client";

  onMount(() => {
    user.init();
  });

  let client = $state(undefined) as undefined | LeafClient;
  let loggedIn = $derived(!!user.agent);
  let connected = $state(false);
  let authenticatedDid = $state("");

  let messages = $state([]) as string[];
  let wasmFileInput = $state(null) as HTMLInputElement | null;

  // Reload window on hot reload to avoid holding multiple socket connections
  if (import.meta.hot) {
    import.meta.hot.accept(() => {
      window.location.reload();
    });
  }

  $effect(() => {
    user.agent;
    if (!user.agent) return;
    (async () => {
      if (!user.agent) return "no user";

      untrack(() => {
        if (!user.agent) return;
        client = new LeafClient("http://localhost:5530", async () => {
          const data = await user.agent!.com.atproto.server.getServiceAuth({
            aud: "did:web:localhost:5530",
          });
          return data.data.token;
        });

        client.on("connect", () => {
          console.log("connected");
          connected = true;
        });
        client.on("disconnect", () => {
          console.log("disconnected");
          connected = false;
        });
        client.on("authenticated", (did) => (authenticatedDid = did));
        client.on("error", (error) => messages.push(error));
        client.on("event", (event) => {
          messages.push(JSON.stringify(event));
        });
      });
    })();
  });

  async function uploadWasm() {
    const bytes = await wasmFileInput?.files?.item(0)?.arrayBuffer();
    if (!bytes) return;
    try {
      const wasmId = await client?.uploadWasm(bytes);
      messages.push("Uploaded WASM: " + wasmId);
    } catch (e) {
      messages.push("Error uploading wasm: " + e);
    }
  }

  let hasWasmId = $state("");
  async function checkHasWasm() {
    try {
      const hasWasm = await client?.hasWasm(hasWasmId);
      messages.push(`Has WASM ${hasWasmId}: ${hasWasm}`);
    } catch (e) {
      messages.push("Error chekcing for wasm: " + e);
    }
  }

  let moduleId = $state("");
  let params = $state("");
  async function createStream() {
    if (!user.agent) return;
    try {
      const streamId = await client?.createStream(
        moduleId,
        new TextEncoder().encode(params).buffer,
      );
      messages.push(`Created stream: ${streamId}`);
    } catch (e) {
      messages.push("Error creating stream: " + e);
    }
  }

  let streamId = $state("");
  onMount(() => {
    streamId = localStorage.getItem("leaf-dash-stream-id") || "";
  });
  $effect(() => {
    if (streamId) {
      localStorage.setItem("leaf-dash-stream-id", streamId);
    }
  });
  let eventPayload = $state("");
  async function sendEvent() {
    if (!user.agent) return;
    try {
      await client?.sendEvent(
        streamId,
        new TextEncoder().encode(eventPayload).buffer,
      );
      messages.push(`Sent event`);
    } catch (e) {
      messages.push("Error sending event: " + e);
    }
  }

  let offset = $state(1);
  let limit = $state(25);
  let fetchFilter = $state("");
  async function fetchEvents() {
    if (!user.agent || !client) return;
    const startFetch = Date.now();
    try {
      const events = await client.fetchEvents(streamId, {
        limit,
        offset,
        filter: fetchFilter
          ? new TextEncoder().encode(fetchFilter).buffer
          : undefined,
      });
      messages.push(
        `Fetched ${events.length} events in ${(Date.now() - startFetch) / 1000} seconds: \n` +
          events
            .map(
              (x) =>
                `  ${x.idx}(${x.user}):` +
                new TextDecoder().decode(new Uint8Array(x.payload)),
            )
            .join("\n"),
      );
    } catch (e) {
      messages.push("Error Fetching events: " + e);
    }
  }

  async function subscribe() {
    if (!user.agent) return;
    try {
      await client?.subscribe(streamId);
      messages.push(`Subscribed to stream: ${streamId}`);
    } catch (e) {
      messages.push("Error subscribing to stream: " + e);
    }
  }
  async function unsubscribe() {
    if (!user.agent) return;
    try {
      const subscribed = await client?.unsubscribe(streamId);

      if (subscribed) {
        messages.push(`Unsubscribed to stream: ${streamId}`);
      } else {
        messages.push(`Tried to unsubscribe but wasn't actually subscribed.`);
      }
    } catch (e) {
      messages.push("Error subscribing to stream: " + e);
    }
  }

  let discordFileInput = $state(null) as HTMLInputElement | null;
  async function importDiscord() {
    const file = discordFileInput?.files?.item(0);
    if (!file) return;

    const reader = new zip.ZipReader(new zip.BlobReader(file));

    messages.push("starting import");

    const startTime = Date.now();
    let count = 0;
    let finished_count = 0;
    let batchPromises = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (!entry.getData) continue;

      const dataWriter = new zip.BlobWriter("application/json");
      await entry.getData(dataWriter);
      const data = new Uint8Array(
        await (await dataWriter.getData()).arrayBuffer(),
      );
      if (data.length == 0) continue;

      const parsed: types.ImportChannel = JSON.parse(
        new TextDecoder().decode(data),
      );

      const batchSize = 1000;
      let batch = [];
      for (const message of parsed.messages) {
        count += 1;
        batch.push(new TextEncoder().encode(JSON.stringify(message)).buffer);
        if (batch.length >= batchSize) {
          const promise = client?.sendEvents(streamId, batch);
          batchPromises.push(promise);
          promise
            ?.then(() => {
              finished_count += batchSize;
            })
            .catch((e) => {
              finished_count += batchSize;
              messages.push("Error uploading batch: " + e);
            });
          batch = [];
        }
      }
      const promise = client?.sendEvents(streamId, batch);
      batchPromises.push(promise);
      promise
        ?.then(() => {
          finished_count += batchSize;
        })
        .catch((e) => {
          finished_count += batchSize;
          messages.push("Error uploading batch: " + e);
        });

      messages.push(`importing channel: ${parsed.channel.name}`);
    }

    await new Promise((resolve) => {
      const check = () => {
        let secondsElapsed = (Date.now() - startTime) / 1000;
        messages.push(
          `Finished ${finished_count} / ${count} messages at ${finished_count / secondsElapsed} messages/second.`,
        );
        if (finished_count >= count) {
          resolve(undefined);
        } else {
          setTimeout(check, 5000);
        }
      };
      check();
    });
    await Promise.all(batchPromises);

    messages.push(
      `Done importing ${count} messages in ${(Date.now() - startTime) / 1000} seconds`,
    );
  }
</script>

<div class="flex flex-row thin-scrollbars">
  <div class="flex flex-col mx-20 h-screen overflow-y-auto shrink-0">
    <h1 class="text-xl my-3">Leaf Dashboard</h1>

    <div class="ml-3">
      <div>
        Logged In: <span class={loggedIn ? "text-green-500" : "text-red-500"}
          >{loggedIn}</span
        >
      </div>
      <div>
        Connected: <span class={connected ? "text-green-500" : "text-red-500"}
          >{connected ? "true" : "false"}</span
        >
      </div>
      <div>Authenticated: {authenticatedDid || "no"}</div>
    </div>

    <div class="my-3">
      <h2 class="text-lg">Upload WASM</h2>

      <form class="flex gap-2 m-2 ml-3" onsubmit={uploadWasm}>
        <Input bind:ref={wasmFileInput} type="file" accept=".wasm" />
        <Button type="submit">Upload</Button>
      </form>
    </div>
    <div class="my-3">
      <h2 class="text-lg">Has WASM</h2>

      <form class="flex gap-2 m-2 ml-3" onsubmit={checkHasWasm}>
        <Input bind:value={hasWasmId} class="w-full" />
        <Button type="submit">Check</Button>
      </form>
    </div>
    <div class="my-3 w-full">
      <h2 class="text-lg">Create Stream</h2>

      <form
        class="flex flex-col w-[20em] gap-3 m-2 ml-3"
        onsubmit={createStream}
      >
        <label>
          Module
          <Input bind:value={moduleId} class="w-full" />
        </label>
        <label>
          Params
          <Input bind:value={params} class="w-full" />
        </label>
        <Button type="submit">Create</Button>
      </form>
    </div>

    <div class="my-3 w-full">
      <h2 class="text-lg">Fetch Event</h2>

      <form
        class="flex flex-col w-[20em] gap-3 m-2 ml-3"
        onsubmit={fetchEvents}
      >
        <label>
          Stream
          <Input bind:value={streamId} class="w-full" />
        </label>
        <label>
          Offset
          <Input type="number" bind:value={offset} class="w-full" />
        </label>
        <label>
          Limit
          <Input type="number" bind:value={limit} class="w-full" />
        </label>
        <label>
          Filter
          <Input bind:value={fetchFilter} class="w-full" />
        </label>
        <Button type="submit">Fetch</Button>
      </form>
    </div>

    <div class="my-3 w-full">
      <h2 class="text-lg">Subscribe</h2>

      <form class="flex flex-col w-[20em] gap-3 m-2 ml-3">
        <label>
          Stream
          <Input bind:value={streamId} class="w-full" />
        </label>
        <Button onclick={subscribe}>Subscribe</Button>
        <Button onclick={unsubscribe}>Unsubscribe</Button>
      </form>
    </div>

    <div class="my-3">
      <h2 class="text-lg">Send Event</h2>

      <form class="flex flex-col w-[20em] gap-3 m-2 ml-3" onsubmit={sendEvent}>
        <label>
          Stream
          <Input bind:value={streamId} class="w-full" />
        </label>
        <label>
          Event Payload
          <Textarea bind:value={eventPayload} class="w-full" />
        </label>
        <Button type="submit">Send</Button>
      </form>
    </div>

    <div class="my-3">
      <h2 class="text-lg">Import Discord Messages</h2>

      <form
        class="flex flex-col w-[20em] gap-3 m-2 ml-3"
        onsubmit={importDiscord}
      >
        <Input bind:ref={discordFileInput} type="file" accept=".zip" />
        <Button type="submit">Import</Button>
      </form>
    </div>
  </div>

  <div class="py-3 grow shrink overflow-y-auto h-screen">
    <h2 class="text-lg">Messages</h2>
    <ul class="ml-3 shrink-0">
      {#each messages as m}
        <li><pre>{m}</pre></li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .thin-scrollbars * {
    scrollbar-width: thin;
    scrollbar-color: var(--accent-900) var(--base-950);
  }
</style>
