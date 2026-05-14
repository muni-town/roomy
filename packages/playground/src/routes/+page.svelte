<script lang="ts">
  import { onMount } from "svelte";
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
      const result = await initSession(storedDid);
      if (result) {
        session = result.session;
        agent = result.agent;
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

{#if initError}
  <pre class="error">Init failed: {initError}</pre>
{:else if !authenticated}
  <h1>Playground</h1>
  <p class="subtitle">PDS proxy auth validation</p>
  <div class="steps">
    <strong>Prerequisites:</strong> Start a tunnel to the appserver and set
    <code>APPSERVER_DID</code> / <code>APPSERVER_ORIGIN</code> accordingly.
    For example with Tailscale Funnel:<br />
    <code>tailscale serve --bg --tunneled-port 8080 http://localhost:8080</code>
  </div>
  <label for="appserver-did">Appserver DID</label>
  <input id="appserver-did" type="text" bind:value={appserverDid} />
  <label for="handle">ATProto handle</label>
  <input id="handle" type="text" placeholder="user.bsky.social" bind:value={handle} />
  <br />
  <button class="primary" onclick={handleLogin} disabled={!handle.trim() || !appserverDid.trim()}>Login</button>
{:else}
  <h1>Playground</h1>
  <p>Authenticated as <strong>{agent?.did}</strong></p>
  <p>Appserver DID: <strong>{appserverDid}</strong></p>
  <p class="status">Scope: <code>atproto transition:generic</code></p>

  <h2>Auth ticket</h2>
  <button class="primary" onclick={onCallTicket} disabled={loading}>Get Connection Ticket</button>

  <h2>Admin: space ops</h2>
  <p class="subtitle">Caller DID must be on the appserver's
    <code>APPSERVER_ADMIN_DIDS</code> allowlist.</p>
  <label for="stream-did">Stream DID</label>
  <input id="stream-did" type="text" placeholder="did:key:..." bind:value={streamDid} />
  <br />
  <button onclick={() => onConnectSpace()} disabled={loading}>Connect Space</button>
  <button onclick={() => onMaterializeSpace(false)} disabled={loading}>Materialize Space</button>
  <button onclick={() => onMaterializeSpace(true)} disabled={loading}>Materialize + Wait Backfill</button>

  <h2>Reads</h2>
  <button class="primary" onclick={onGetSpaces} disabled={loading}>Get My Spaces</button>

  <h3>Space queries</h3>
  <label for="space-id">Space ID</label>
  <input id="space-id" type="text" placeholder="did:web:..." bind:value={spaceId} />
  <br />
  <button onclick={() => onSpaceQuery(NSIDS.GET_SPACE_METADATA, "Fetching space metadata")} disabled={loading}>Get Metadata</button>
  <button onclick={() => onSpaceQuery(NSIDS.GET_MEMBERS, "Fetching members")} disabled={loading}>Get Members</button>
  <button onclick={() => onSpaceQuery(NSIDS.GET_SPACE_THREADS, "Fetching threads")} disabled={loading}>Get Threads</button>
  <button onclick={() => onSpaceQuery(NSIDS.GET_ROLES, "Fetching roles")} disabled={loading}>Get Roles</button>
  <button onclick={() => onSpaceQuery(NSIDS.GET_INVITES, "Fetching invites")} disabled={loading}>Get Invites</button>

  <h3>Room queries</h3>
  <label for="room-id">Room ID</label>
  <input id="room-id" type="text" placeholder="01..." bind:value={roomId} />
  <br />
  <label for="message-limit">limit</label>
  <input id="message-limit" type="number" min="1" max="100" style="width:5em" bind:value={messageLimit} />
  <label for="message-cursor">cursor</label>
  <input id="message-cursor" type="text" placeholder="(optional)" bind:value={messageCursor} />
  <br />
  <button onclick={() => onRoomQuery(NSIDS.GET_ROOM_METADATA, "Fetching room metadata")} disabled={loading}>Get Metadata</button>
  <button onclick={() => onRoomQuery(NSIDS.GET_ROOM_THREADS, "Fetching room threads")} disabled={loading}>Get Threads</button>
  <button onclick={onGetMessages} disabled={loading}>Get Messages</button>

  <h3>Message query</h3>
  <label for="message-id">Message ID</label>
  <input id="message-id" type="text" placeholder="01..." bind:value={messageId} />
  <br />
  <button onclick={onGetMessage} disabled={loading}>Get Message</button>

  <h2>WebSocket Sync</h2>
  <p class="subtitle">Connects directly to the appserver (not proxied through PDS).</p>
  <label for="ws-url">Appserver WS URL</label>
  <input id="ws-url" type="text" placeholder="ws://localhost:8080" bind:value={wsUrl} />
  <br />
  <button class="primary" onclick={onWsConnect} disabled={wsConnected}>Connect</button>
  <button onclick={onWsDisconnect} disabled={!wsConnected}>Disconnect</button>
  <span class="status">{wsConnected ? "Connected" : "Disconnected"}</span>

  <h3>Subscriptions</h3>
  <label for="ws-sub-topic">Topic</label>
  <select id="ws-sub-topic" bind:value={wsSubTopic}>
    <option value="space">space</option>
    <option value="room">room</option>
  </select>
  <label for="ws-sub-id">ID</label>
  <input id="ws-sub-id" type="text" placeholder="space DID or room ULID" bind:value={wsSubId} />
  <br />
  <button onclick={onWsSub}>Subscribe</button>
  <button onclick={onWsUnsub}>Unsubscribe</button>
  <button onclick={onWsCursor}>Send Cursor (seq=0)</button>
  <br />
  <button onclick={onWsClearLog}>Clear Log</button>
  <div class="ws-log">
    {#each wsLog as line}
      <div>{line}</div>
    {/each}
  </div>

  <br />
  <button onclick={handleLogout}>Logout</button>
{/if}

<pre class={resultError ? "error" : "status"}>{result}</pre>

<style>
  :global(body) {
    font-family: -apple-system, system-ui, sans-serif;
    max-width: 640px;
    margin: 2rem auto;
    padding: 0 1rem;
    color: #1a1a1a;
  }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 500; }
  input[type="text"], input[type="number"], select {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 0.95rem;
    box-sizing: border-box;
  }
  select { width: auto; }
  button {
    margin: 0.75rem 0.25rem 0;
    padding: 0.5rem 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button.primary {
    background: #2563eb;
    color: white;
    border-color: #2563eb;
  }
  button.primary:hover { background: #1d4ed8; }
  button:hover { background: #f5f5f5; }
  button.primary:hover { background: #1d4ed8; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre {
    background: #f4f4f5;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 0.85rem;
    margin-top: 1rem;
  }
  pre.error { background: #fef2f2; color: #991b1b; }
  .steps {
    background: #f0f9ff;
    border: 1px solid #bae6fd;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
    font-size: 0.85rem;
  }
  .steps :global(code) { background: #e0f2fe; padding: 0.1em 0.3em; border-radius: 3px; }
  .status { color: #666; font-style: italic; }
  .ws-log {
    background: #f4f4f5;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-y: auto;
    max-height: 300px;
    font-size: 0.8rem;
    font-family: monospace;
    white-space: pre-wrap;
    margin-top: 0.5rem;
  }
</style>
