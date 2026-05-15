<script lang="ts">
  import { onMount } from "svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import {
    callTicket,
    callConnectSpace,
    callMaterializeSpace,
    callGetSpaces,
    callSpaceQuery,
    callRoomQuery,
    callGetMessages,
    callGetMessage,
    NSIDS,
    decodeCborFrame,
    saveAppserverDid,
    loadAppserverDid,
    initSession,
    login,
    logout,
    makeProxiedAgent,
  } from "$lib/xrpc";
  import type { Agent } from "@atproto/api";
  import type { OAuthSession } from "@atproto/oauth-client-browser";

  // ── Auth state ──────────────────────────────────────────────────────────

  let authenticated = $state(false);
  let agent: Agent | null = $state(null);
  let session: OAuthSession | null = $state(null);
  let appserverDid = $state(loadAppserverDid());
  let handle = $state("");
  let initError = $state("");

  // ── Form state ──────────────────────────────────────────────────────────

  let streamDid = $state(sessionStorage.getItem("stream-did") ?? "");
  let spaceId = $state(sessionStorage.getItem("space-id") ?? "");
  let roomId = $state(sessionStorage.getItem("room-id") ?? "");
  let messageId = $state(sessionStorage.getItem("message-id") ?? "");
  let messageLimit = $state(sessionStorage.getItem("message-limit") ?? "50");
  let messageCursor = $state(sessionStorage.getItem("message-cursor") ?? "");

  // ── Result ──────────────────────────────────────────────────────────────

  let result = $state("Ready");
  let resultError = $state(false);
  let loading = $state(false);

  // ── WebSocket sync state ────────────────────────────────────────────────

  let wsUrl = $state(sessionStorage.getItem("ws-url") ?? "ws://localhost:8080");
  let wsConnected = $state(false);
  let wsSubTopic = $state<"space" | "room">("space");
  let wsSubId = $state(sessionStorage.getItem("ws-sub-id") ?? "");
  let wsLog = $state<string[]>(["No events yet."]);
  let syncWs: WebSocket | null = null;
  let lastSeq = 0;

  // ── Persist inputs on change ────────────────────────────────────────────

  $effect(() => { if (streamDid) sessionStorage.setItem("stream-did", streamDid); });
  $effect(() => { if (spaceId) sessionStorage.setItem("space-id", spaceId); });
  $effect(() => { if (roomId) sessionStorage.setItem("room-id", roomId); });
  $effect(() => { if (messageId) sessionStorage.setItem("message-id", messageId); });
  $effect(() => { if (messageLimit) sessionStorage.setItem("message-limit", messageLimit); });
  $effect(() => { if (messageCursor) sessionStorage.setItem("message-cursor", messageCursor); });
  $effect(() => { if (wsUrl) sessionStorage.setItem("ws-url", wsUrl); });
  $effect(() => { if (wsSubId) sessionStorage.setItem("ws-sub-id", wsSubId); });

  // ── Helpers ─────────────────────────────────────────────────────────────

  function renderResult(value: unknown, isError = false) {
    resultError = isError;
    result = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  async function runCall(label: string, fn: () => Promise<unknown>) {
    renderResult(`${label}…`);
    loading = true;
    try {
      const data = await fn();
      renderResult(data);
    } catch (err: any) {
      const detail = err?.headers
        ? `\n\nHeaders: ${JSON.stringify(err.headers, null, 2)}`
        : "";
      renderResult(
        `${err?.error || "Error"}: ${err?.message || err}${detail}`,
        true,
      );
    } finally {
      loading = false;
    }
  }

  function appendWsLog(text: string, cls?: string) {
    wsLog = [...wsLog, (cls === "error" ? "❌ " : "") + text];
  }

  // ── Init ────────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      const storedDid = loadAppserverDid();
      const res = await initSession(storedDid);
      if (res) {
        session = res.session;
        agent = res.agent;
        authenticated = true;
        appserverDid = storedDid;
      }
    } catch (err) {
      initError = String(err);
    }
  });

  // ── Login handler ───────────────────────────────────────────────────────

  async function handleLogin() {
    if (!handle.trim() || !appserverDid.trim()) return;
    saveAppserverDid(appserverDid.trim());
    await login(appserverDid.trim(), handle.trim());
  }

  async function handleLogout() {
    if (session) {
      await logout(session);
    }
    authenticated = false;
    agent = null;
    session = null;
    location.reload();
  }

  // ── XRPC call handlers ──────────────────────────────────────────────────

  function onCallTicket() {
    runCall("Requesting connection ticket", () => callTicket(agent!, appserverDid));
  }

  function onConnectSpace() {
    if (!streamDid.trim()) { renderResult({ error: "Missing stream DID" }, true); return; }
    runCall("Connecting to space", () => callConnectSpace(agent!, appserverDid, streamDid.trim()));
  }

  function onMaterializeSpace(wait: boolean) {
    if (!streamDid.trim()) { renderResult({ error: "Missing stream DID" }, true); return; }
    runCall(
      wait ? "Materializing space (awaiting backfill)" : "Materializing space",
      () => callMaterializeSpace(agent!, appserverDid, streamDid.trim(), wait),
    );
  }

  function onGetSpaces() {
    runCall("Fetching joined spaces", () => callGetSpaces(agent!, appserverDid));
  }

  function onSpaceQuery(nsid: string, label: string) {
    if (!spaceId.trim()) { renderResult({ error: "Missing space ID" }, true); return; }
    runCall(label, () => callSpaceQuery(agent!, appserverDid, nsid, spaceId.trim()));
  }

  function onRoomQuery(nsid: string, label: string) {
    if (!roomId.trim()) { renderResult({ error: "Missing room ID" }, true); return; }
    runCall(label, () => callRoomQuery(agent!, appserverDid, nsid, roomId.trim()));
  }

  function onGetMessages() {
    if (!roomId.trim()) { renderResult({ error: "Missing room ID" }, true); return; }
    runCall("Fetching messages", () =>
      callGetMessages(agent!, appserverDid, roomId.trim(), messageLimit.trim() || undefined, messageCursor.trim() || undefined),
    );
  }

  function onGetMessage() {
    if (!messageId.trim()) { renderResult({ error: "Missing message ID" }, true); return; }
    runCall("Fetching message", () => callGetMessage(agent!, appserverDid, messageId.trim()));
  }

  // ── WebSocket sync handlers ─────────────────────────────────────────────

  async function onWsConnect() {
    if (!wsUrl.trim()) { renderResult({ error: "Missing WS URL" }, true); return; }

    appendWsLog("Requesting ticket…");
    let ticket: string;
    try {
      const proxied = makeProxiedAgent(agent!, appserverDid);
      const response = await proxied.call("space.roomy.auth.getConnectionTicket");
      ticket = (response.data as any).ticket;
      appendWsLog(`Got ticket: ${ticket.slice(0, 12)}…`);
    } catch (err: any) {
      appendWsLog(`Ticket failed: ${err?.message ?? err}`);
      return;
    }

    const url = `${wsUrl}/xrpc/space.roomy.sync.subscribe?ticket=${encodeURIComponent(ticket)}`;
    appendWsLog(`Connecting to ${url.split("?")[0]}…`);

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    syncWs = ws;

    ws.onopen = () => {
      wsConnected = true;
      appendWsLog("Connected.");
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        appendWsLog(`[text] ${event.data}`);
        return;
      }

      try {
        const { header, body } = decodeCborFrame(event.data as ArrayBuffer);
        const t = header["t"] as string;
        const op = header["op"] as number;

        if (t === "#messageDiff") {
          const rId = body["roomId"] as string;
          const seq = body["seq"] as number;
          if (seq > lastSeq) lastSeq = seq;
          const ops = body["ops"] as Array<Record<string, unknown>>;
          const summary = ops.map((o) => `${o.op} ${o.key}`).join(", ");
          appendWsLog(`[${t}] room=${rId.slice(0, 8)}… seq=${seq} ops: ${summary}`);
        } else if (t === "#invalidate") {
          const nsid = body["nsid"] as string;
          const params = body["params"] as Record<string, string>;
          appendWsLog(`[${t}] ${nsid} ${JSON.stringify(params)}`);
        } else if (t === "#error") {
          appendWsLog(`[ERROR] ${body["error"]}: ${body["message"]}`);
        } else {
          appendWsLog(`[unknown t=${t} op=${op}] ${JSON.stringify(body)}`);
        }
      } catch (err) {
        appendWsLog(`[decode error] ${err}`);
      }
    };

    ws.onclose = (event) => {
      wsConnected = false;
      syncWs = null;
      appendWsLog(`Connection closed: code=${event.code} reason=${event.reason}`);
    };

    ws.onerror = () => {
      appendWsLog("WebSocket error (see console).");
    };
  }

  function onWsDisconnect() {
    syncWs?.close();
    syncWs = null;
    wsConnected = false;
  }

  function onWsSub() {
    if (!syncWs || syncWs.readyState !== WebSocket.OPEN) { appendWsLog("Not connected."); return; }
    if (!wsSubId.trim()) { appendWsLog("Missing ID."); return; }
    const msg = JSON.stringify({ type: "sub", topic: wsSubTopic, id: wsSubId.trim() });
    syncWs.send(msg);
    appendWsLog(`→ sub ${wsSubTopic}:${wsSubId}`);
  }

  function onWsUnsub() {
    if (!syncWs || syncWs.readyState !== WebSocket.OPEN) { appendWsLog("Not connected."); return; }
    if (!wsSubId.trim()) return;
    const msg = JSON.stringify({ type: "unsub", topic: wsSubTopic, id: wsSubId.trim() });
    syncWs.send(msg);
    appendWsLog(`→ unsub ${wsSubTopic}:${wsSubId}`);
  }

  function onWsCursor() {
    if (!syncWs || syncWs.readyState !== WebSocket.OPEN) { appendWsLog("Not connected."); return; }
    const msg = JSON.stringify({ type: "cursor", seq: lastSeq });
    syncWs.send(msg);
    appendWsLog(`→ cursor seq=${lastSeq}`);
  }

  function onWsClearLog() {
    wsLog = ["Log cleared."];
  }
</script>

<div class="mx-auto max-w-[640px] px-4 py-8 text-base-800 dark:text-base-200">
  {#if initError}
    <pre class="text-red-800 bg-red-50 p-3 rounded-2xl text-sm whitespace-pre-wrap">{initError}</pre>
  {:else if !authenticated}
    <h1 class="text-2xl font-bold mb-1">Playground</h1>
    <p class="text-base-500 dark:text-base-400 mb-4">PDS proxy auth validation</p>
    <div class="bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 rounded-2xl p-4 text-sm mb-4">
      <strong>Prerequisites:</strong> Start a tunnel to the appserver and set
      <code class="bg-sky-100 dark:bg-sky-900/50 px-1 rounded">APPSERVER_DID</code> /
      <code class="bg-sky-100 dark:bg-sky-900/50 px-1 rounded">APPSERVER_ORIGIN</code> accordingly.
      For example with Tailscale Funnel:<br />
      <code class="bg-sky-100 dark:bg-sky-900/50 px-1 rounded">tailscale serve --bg --tunneled-port 8080 http://localhost:8080</code>
    </div>

    <label for="appserver-did" class="block mt-3 mb-1 font-medium text-sm">Appserver DID</label>
    <Input id="appserver-did" bind:value={appserverDid} />

    <label for="handle" class="block mt-3 mb-1 font-medium text-sm">ATProto handle</label>
    <Input id="handle" placeholder="user.bsky.social" bind:value={handle} />

    <Button class="mt-3" onclick={handleLogin} disabled={!handle.trim() || !appserverDid.trim()}>Login</Button>
  {:else}
    <h1 class="text-2xl font-bold mb-1">Playground</h1>
    <p class="mb-1">Authenticated as <strong>{agent?.did}</strong></p>
    <p class="mb-1">Appserver DID: <strong>{appserverDid}</strong></p>
    <p class="text-base-500 dark:text-base-400 italic text-sm mb-6">Scope: <code class="bg-base-200/50 dark:bg-base-800/50 px-1 rounded">atproto transition:generic</code></p>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-2">Auth ticket</h2>
      <Button onclick={onCallTicket} disabled={loading}>Get Connection Ticket</Button>
    </section>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-1">Admin: space ops</h2>
      <p class="text-base-500 dark:text-base-400 text-sm mb-2">Caller DID must be on the appserver's
        <code class="bg-base-200/50 dark:bg-base-800/50 px-1 rounded">APPSERVER_ADMIN_DIDS</code> allowlist.</p>
      <label for="stream-did" class="block mb-1 font-medium text-sm">Stream DID</label>
      <Input id="stream-did" placeholder="did:key:..." bind:value={streamDid} />
      <div class="flex flex-wrap gap-1 mt-2">
        <Button variant="secondary" onclick={() => onConnectSpace()} disabled={loading}>Connect Space</Button>
        <Button variant="secondary" onclick={() => onMaterializeSpace(false)} disabled={loading}>Materialize Space</Button>
        <Button variant="secondary" onclick={() => onMaterializeSpace(true)} disabled={loading}>Materialize + Wait Backfill</Button>
      </div>
    </section>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-2">Reads</h2>
      <Button onclick={onGetSpaces} disabled={loading}>Get My Spaces</Button>
    </section>

    <section class="mb-6">
      <h3 class="text-base font-semibold mb-2">Space queries</h3>
      <label for="space-id" class="block mb-1 font-medium text-sm">Space ID</label>
      <Input id="space-id" placeholder="did:web:..." bind:value={spaceId} />
      <div class="flex flex-wrap gap-1 mt-2">
        <Button variant="secondary" onclick={() => onSpaceQuery(NSIDS.GET_SPACE_METADATA, "Fetching space metadata")} disabled={loading}>Get Metadata</Button>
        <Button variant="secondary" onclick={() => onSpaceQuery(NSIDS.GET_MEMBERS, "Fetching members")} disabled={loading}>Get Members</Button>
        <Button variant="secondary" onclick={() => onSpaceQuery(NSIDS.GET_SPACE_THREADS, "Fetching threads")} disabled={loading}>Get Threads</Button>
        <Button variant="secondary" onclick={() => onSpaceQuery(NSIDS.GET_ROLES, "Fetching roles")} disabled={loading}>Get Roles</Button>
        <Button variant="secondary" onclick={() => onSpaceQuery(NSIDS.GET_INVITES, "Fetching invites")} disabled={loading}>Get Invites</Button>
      </div>
    </section>

    <section class="mb-6">
      <h3 class="text-base font-semibold mb-2">Room queries</h3>
      <label for="room-id" class="block mb-1 font-medium text-sm">Room ID</label>
      <Input id="room-id" placeholder="01..." bind:value={roomId} />
      <div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 items-center mt-2">
        <label for="message-limit" class="text-sm font-medium">limit</label>
        <Input id="message-limit" type="number" min={1} max={100} bind:value={messageLimit} />
        <label for="message-cursor" class="text-sm font-medium">cursor</label>
        <Input id="message-cursor" placeholder="(optional)" bind:value={messageCursor} />
      </div>
      <div class="flex flex-wrap gap-1 mt-2">
        <Button variant="secondary" onclick={() => onRoomQuery(NSIDS.GET_ROOM_METADATA, "Fetching room metadata")} disabled={loading}>Get Metadata</Button>
        <Button variant="secondary" onclick={() => onRoomQuery(NSIDS.GET_ROOM_THREADS, "Fetching room threads")} disabled={loading}>Get Threads</Button>
        <Button variant="secondary" onclick={onGetMessages} disabled={loading}>Get Messages</Button>
      </div>
    </section>

    <section class="mb-6">
      <h3 class="text-base font-semibold mb-2">Message query</h3>
      <label for="message-id" class="block mb-1 font-medium text-sm">Message ID</label>
      <Input id="message-id" placeholder="01..." bind:value={messageId} />
      <Button variant="secondary" class="mt-2" onclick={onGetMessage} disabled={loading}>Get Message</Button>
    </section>

    <section class="mb-6">
      <h2 class="text-lg font-semibold mb-1">WebSocket Sync</h2>
      <p class="text-base-500 dark:text-base-400 text-sm mb-2">Connects directly to the appserver (not proxied through PDS).</p>
      <label for="ws-url" class="block mb-1 font-medium text-sm">Appserver WS URL</label>
      <Input id="ws-url" placeholder="ws://localhost:8080" bind:value={wsUrl} />
      <div class="flex flex-wrap items-center gap-1 mt-2">
        <Button onclick={onWsConnect} disabled={wsConnected}>Connect</Button>
        <Button variant="secondary" onclick={onWsDisconnect} disabled={!wsConnected}>Disconnect</Button>
        <span class="text-sm italic text-base-500 dark:text-base-400">{wsConnected ? "Connected" : "Disconnected"}</span>
      </div>

      <h3 class="text-base font-semibold mt-4 mb-2">Subscriptions</h3>
      <div class="flex flex-wrap items-end gap-2">
        <div>
          <label for="ws-sub-topic" class="block mb-1 font-medium text-sm">Topic</label>
          <select id="ws-sub-topic" bind:value={wsSubTopic} class="rounded-2xl border-0 text-sm font-medium bg-base-200/50 dark:bg-base-800/50 px-3 py-1.5">
            <option value="space">space</option>
            <option value="room">room</option>
          </select>
        </div>
        <div class="flex-1 min-w-[200px]">
          <label for="ws-sub-id" class="block mb-1 font-medium text-sm">ID</label>
          <Input id="ws-sub-id" placeholder="space DID or room ULID" bind:value={wsSubId} />
        </div>
      </div>
      <div class="flex flex-wrap gap-1 mt-2">
        <Button variant="secondary" onclick={onWsSub}>Subscribe</Button>
        <Button variant="secondary" onclick={onWsUnsub}>Unsubscribe</Button>
        <Button variant="secondary" onclick={onWsCursor}>Send Cursor (seq=0)</Button>
        <Button variant="ghost" onclick={onWsClearLog}>Clear Log</Button>
      </div>
      <div class="bg-base-100 dark:bg-base-900/50 p-3 rounded-2xl max-h-[300px] overflow-y-auto text-xs font-mono whitespace-pre-wrap mt-2">
        {#each wsLog as line}
          <div>{line}</div>
        {/each}
      </div>
    </section>

    <Button variant="ghost" onclick={handleLogout}>Logout</Button>
  {/if}

  <pre class="mt-4 p-3 rounded-2xl text-sm whitespace-pre-wrap overflow-x-auto {resultError ? 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300' : 'bg-base-100 dark:bg-base-900/50 text-base-600 dark:text-base-400'}">{result}</pre>
</div>
