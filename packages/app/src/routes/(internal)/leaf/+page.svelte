<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { onMount, untrack } from "svelte";
  import { io, Socket } from "socket.io-client";
  import { Input, Button, Textarea } from "@fuxui/base";
  import parser from "socket.io-msgpack-parser";
  import * as zip from "@zip-js/zip-js";
  import * as types from "./discordTypes";

  import { formatDistance } from "date-fns";

  onMount(() => {
    user.init();
  });

  let socket = $state(undefined) as undefined | Socket;
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

  const logOutgoing = (...args: any[]) => {
    messages.push("→ " + JSON.stringify(args));
  };

  $effect(() => {
    user.agent;
    if (!user.agent) return;
    (async () => {
      if (!user.agent) return "no user";

      untrack(() => {
        socket = io("https://leaf.muni.town", {
          parser,
          async auth(cb) {
            const resp = await user.agent?.com.atproto.server.getServiceAuth({
              aud: "did:web:roomy.space",
              lxm: "space.roomy.token.v0",
            });
            const token = resp?.data.token;
            if (!token) return;
            cb({ token });
          },
        });
        socket.compress(true);
        socket.connected;
        socket.on("connect", () => (connected = true));
        socket.on("disconnect", () => (connected = false));

        socket.on("authenticated", (data) => {
          authenticatedDid = data.did;
        });
        socket.onAny((...args: any[]) => {
          messages.push("← " + JSON.stringify(args));
        });
        socket.onAnyOutgoing(logOutgoing);
      });
    })();
  });

  async function uploadWasm() {
    const bytes = await wasmFileInput?.files?.item(0)?.arrayBuffer();
    if (!bytes) return;
    const resp = await socket?.emitWithAck("wasm/upload", bytes);
    messages.push("←← wasm/upload: " + JSON.stringify(resp));
  }

  let hasWasmId = $state("");
  async function checkHasWasm() {
    const resp = await socket?.emitWithAck("wasm/has", hasWasmId);
    messages.push("←← wasm/has: " + JSON.stringify(resp));
  }

  let moduleId = $state("");
  let params = $state("");
  async function createStream() {
    if (!user.agent) return;
    const resp = await socket?.emitWithAck("stream/create", {
      module: moduleId,
      params,
    });
    messages.push("←← stream/create: " + JSON.stringify(resp));
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
    const data = new TextEncoder().encode(eventPayload);
    const resp = await socket?.emitWithAck("stream/event", {
      id: streamId,
      payload: data.buffer,
    });
    messages.push("←← stream/event: " + JSON.stringify(resp));
  }

  let offset = $state(1);
  let limit = $state(25);
  async function fetchEvents() {
    if (!user.agent) return;
    const resp: { events: { payload: number[]; idx: number; user: string }[] } =
      await socket?.emitWithAck("stream/fetch", {
        id: streamId,
        offset,
        limit,
      });
    messages.push(
      "←← stream/fetch: \n" +
        resp.events
          .map(
            (x) =>
              `  ${x.idx}(${x.user}):` +
              new TextDecoder().decode(new Uint8Array(x.payload)),
          )
          .join("\n"),
    );
  }

  async function subscribe() {
    if (!user.agent) return;
    const resp = await socket?.emitWithAck("stream/subscribe", streamId);
    messages.push("←← stream/subscribe: " + JSON.stringify(resp));
  }
  async function unsubscribe() {
    if (!user.agent) return;
    const resp = await socket?.emitWithAck("stream/unsubscribe", streamId);
    messages.push("←← stream/unsubscribe: " + JSON.stringify(resp));
  }

  let discordFileInput = $state(null) as HTMLInputElement | null;
  async function importDiscord() {
    const file = discordFileInput?.files?.item(0);
    if (!file) return;

    const reader = new zip.ZipReader(new zip.BlobReader(file));

    messages.push("starting import");
    socket?.offAnyOutgoing(logOutgoing);

    const startTime = Date.now();
    let count = 0;
    let finished_count = 0;
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
          socket
            ?.emitWithAck("stream/event_batch", {
              id: streamId,
              payloads: batch,
            })
            .then((ack) => {
              finished_count += batchSize;
              if (ack.error) {
                messages.push("Error: " + ack.error);
              }
            });
          batch = [];
        }
      }
      socket
        ?.emitWithAck("stream/event_batch", {
          id: streamId,
          payloads: batch,
        })
        .then((ack) => {
          finished_count += batchSize;
          if (ack.error) {
            messages.push("Error: " + ack.error);
          }
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

    messages.push(
      `Done importing ${count} messages in ${formatDistance(Date.now(), startTime)} ( ${(Date.now() - startTime) / 1000} seconds )`,
    );

    socket?.onAnyOutgoing(logOutgoing);
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
