<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import {
    callConnectSpace,
    callMaterializeSpace,
    callGetSpaces,
    callSpaceQuery,
    callRoomQuery,
    callGetMessages,
    callGetMessage,
    callAdminGetFlags,
    callAdminSetFlag,
    callAdminClearFlag,
    NSIDS,
  } from "$lib/xrpc";
  import {
    login as authLogin,
    logout as authLogout,
    auth,
  } from "$lib/auth.svelte";
  import { makeProxiedAgent } from "@roomy-space/sdk/browser";
  import { sync } from "@roomy-space/sdk";
  const { decodeCborFrame } = sync;

  // ── Auth state ──────────────────────────────────────────────────────────

  let handle = $state("");

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

  // ── Feature flag state ──────────────────────────────────────────────────

  let flags = $state<Array<{
    key: string;
    description: string;
    globalEnabled: boolean;
    assignedDids: string[];
  }> | null>(null);
  let flagDidsInput = $state<Record<string, string>>({});
  let flagLoading = $state(false);

  async function refreshFlags() {
    flagLoading = true;
    try {
      const data = await callAdminGetFlags(auth.agent!, auth.session!.did);
      flags = data.flags;
    } catch (err: any) {
      flags = null;
      renderResult(`Failed to load flags: ${err?.message ?? err}`, true);
    } finally {
      flagLoading = false;
    }
  }

  async function onFlagToggleGlobal(flagKey: string, current: boolean) {
    flagLoading = true;
    try {
      await callAdminSetFlag(auth.agent!, auth.session!.did, flagKey, !current);
      await refreshFlags();
      renderResult(`Flag "${flagKey}" global set to ${!current}`);
    } catch (err: any) {
      renderResult(`Failed to set flag: ${err?.message ?? err}`, true);
    } finally {
      flagLoading = false;
    }
  }

  async function onFlagSaveDids(flagKey: string) {
    flagLoading = true;
    try {
      const input = flagDidsInput[flagKey] ?? "";
      const dids = input
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await callAdminSetFlag(auth.agent!, auth.session!.did, flagKey, undefined, dids);
      await refreshFlags();
      renderResult(`Flag "${flagKey}" DIDs updated (${dids.length} DID(s))`);
    } catch (err: any) {
      renderResult(`Failed to set flag DIDs: ${err?.message ?? err}`, true);
    } finally {
      flagLoading = false;
    }
  }

  async function onFlagClear(flagKey: string) {
    flagLoading = true;
    try {
      await callAdminClearFlag(auth.agent!, auth.session!.did, flagKey);
      await refreshFlags();
      renderResult(`Flag "${flagKey}" cleared (default off)`);
    } catch (err: any) {
      renderResult(`Failed to clear flag: ${err?.message ?? err}`, true);
    } finally {
      flagLoading = false;
    }
  }
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

  // ── Login handler ───────────────────────────────────────────────────────

  async function handleLogin() {
    if (!handle.trim()) return;
    await authLogin(handle.trim());
  }

  async function handleLogout() {
    await authLogout();
  }

  // ── XRPC call handlers ──────────────────────────────────────────────────

  function onCallTicket() {
    runCall("Requesting connection ticket", () => callTicket(auth.agent!, auth.session!.did));
  }

  function onConnectSpace() {
    if (!streamDid.trim()) { renderResult({ error: "Missing stream DID" }, true); return; }
    runCall("Connecting to space", () => callConnectSpace(auth.agent!, auth.session!.did, streamDid.trim()));
  }

  function onMaterializeSpace(wait: boolean) {
    if (!streamDid.trim()) { renderResult({ error: "Missing stream DID" }, true); return; }
    runCall(
      wait ? "Materializing space (awaiting backfill)" : "Materializing space",
      () => callMaterializeSpace(auth.agent!, auth.session!.did, streamDid.trim(), wait),
    );
  }

  function onGetSpaces() {
    runCall("Fetching joined spaces", () => callGetSpaces(auth.agent!, auth.session!.did));
  }

  function onSpaceQuery(nsid: string, label: string) {
    if (!spaceId.trim()) { renderResult({ error: "Missing space ID" }, true); return; }
    runCall(label, () => callSpaceQuery(auth.agent!, auth.session!.did, nsid, spaceId.trim()));
  }

  function onRoomQuery(nsid: string, label: string) {
    if (!roomId.trim()) { renderResult({ error: "Missing room ID" }, true); return; }
    runCall(label, () => callRoomQuery(auth.agent!, auth.session!.did, nsid, roomId.trim()));
  }

  function onGetMessages() {
    if (!roomId.trim()) { renderResult({ error: "Missing room ID" }, true); return; }
    runCall("Fetching messages", () =>
      callGetMessages(auth.agent!, auth.session!.did, roomId.trim(), messageLimit.trim() || undefined, messageCursor.trim() || undefined),
    );
  }

  function onGetMessage() {
    if (!messageId.trim()) { renderResult({ error: "Missing message ID" }, true); return; }
    runCall("Fetching message", () => callGetMessage(auth.agent!, auth.session!.did, messageId.trim()));
  }

  // ── WebSocket sync handlers ─────────────────────────────────────────────

  async function onWsConnect() {
    if (!wsUrl.trim()) { renderResult({ error: "Missing WS URL" }, true); return; }

    appendWsLog("Requesting ticket…");
    let ticket: string;
    try {
      const proxied = makeProxiedAgent(auth.agent!, auth.session!.did);
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

<div class="mx-auto max-w-[960px] px-4 py-8 text-base-800 dark:text-base-200">
  {#if auth.initError}
    <pre class="text-red-800 bg-red-50 p-3 rounded-2xl text-sm whitespace-pre-wrap">{auth.initError}</pre>
  {:else if auth.authError}
    <div class="max-w-md mx-auto text-center py-16">
      <h1 class="text-2xl font-bold mb-2">Access Denied</h1>
      <p class="text-red-600 dark:text-red-400 mb-4">{auth.authError}</p>
      <p class="text-sm text-base-500 mb-4">Only DIDs on the admin allowlist can access this dashboard.</p>
      <Button onclick={handleLogout}>Sign out</Button>
    </div>
  {:else if !auth.authenticated}
    <div class="max-w-md mx-auto text-center py-16">
      <h1 class="text-2xl font-bold mb-1">Appserver Admin</h1>
      <p class="text-base-500 dark:text-base-400 mb-4">Sign in with your ATProto handle</p>

      <div class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 text-sm mb-4 text-left">
        <p class="font-medium mb-1">Access control</p>
        <p>Only DIDs listed in <code class="bg-base-200/50 dark:bg-base-800/50 px-1 rounded">PUBLIC_APPSERVER_ADMIN_DIDS</code> can access this dashboard.</p>
      </div>

      <label for="handle" class="block mb-1 font-medium text-sm text-left">ATProto handle</label>
      <Input id="handle" placeholder="user.bsky.social" bind:value={handle} />

      <Button class="mt-3" onclick={handleLogin} disabled={!handle.trim()}>Sign in with AT Protocol</Button>
    </div>
  {:else}
    <!-- ─── Admin header ────────────────────────────────────────────────── -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold">Appserver Admin</h1>
        <p class="text-sm text-base-500">Authenticated as <strong>{auth.session?.did}</strong></p>
      </div>
      <Button variant="ghost" onclick={handleLogout}>Logout</Button>
    </div>

    <!-- ─── Server status ────────────────────────────────────────────────── -->
    <section class="mb-8">
      <h2 class="text-lg font-semibold mb-3">Server Status</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="border border-base-200 dark:border-base-800 rounded-2xl p-4 bg-white dark:bg-base-900/50">
          <p class="text-xs text-base-400 uppercase tracking-wide mb-1">Auth</p>
          <p class="text-sm font-medium text-green-600">Authenticated</p>
          <p class="text-xs text-base-400 mt-1 truncate" title={auth.session!.did}>{auth.session!.did}</p>
        </div>
        <div class="border border-base-200 dark:border-base-800 rounded-2xl p-4 bg-white dark:bg-base-900/50">
          <p class="text-xs text-base-400 uppercase tracking-wide mb-1">WebSocket</p>
          <p class="text-sm font-medium" class:text-green-600={wsConnected} class:text-base-500={!wsConnected}>
            {wsConnected ? "Connected" : "Disconnected"}
          </p>
        </div>
        <div class="border border-base-200 dark:border-base-800 rounded-2xl p-4 bg-white dark:bg-base-900/50">
          <p class="text-xs text-base-400 uppercase tracking-wide mb-1">Appserver DID</p>
          <p class="text-sm font-mono truncate" title={auth.session!.did}>{auth.session!.did}</p>
        </div>
      </div>
    </section>

    <!-- ─── XRPC Debug Tools ────────────────────────────────────────────── -->
    <section class="mb-6">
      <details open>
        <summary class="text-lg font-semibold cursor-pointer mb-3">XRPC Debug Tools</summary>

        <!-- Auth / Connection -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Auth & Connection</h3>
          <div class="flex flex-wrap gap-2">
            <Button onclick={onCallTicket} disabled={loading}>Get Ticket</Button>
            <Button onclick={onGetSpaces} disabled={loading}>Get Spaces</Button>
          </div>
        </div>

        <!-- Space operations -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Space Operations</h3>
          <label for="stream-did" class="block text-xs mb-1">Stream DID</label>
          <Input id="stream-did" bind:value={streamDid} placeholder="did:plc:..." />
          <div class="flex flex-wrap gap-2 mt-2">
            <Button onclick={onConnectSpace} disabled={loading || !streamDid.trim()}>Connect Space</Button>
            <Button onclick={() => onMaterializeSpace(false)} disabled={loading || !streamDid.trim()}>Materialize</Button>
            <Button onclick={() => onMaterializeSpace(true)} disabled={loading || !streamDid.trim()}>Materialize (wait)</Button>
          </div>
        </div>

        <!-- Space queries -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Space Queries</h3>
          <label for="space-id" class="block text-xs mb-1">Space ID</label>
          <Input id="space-id" bind:value={spaceId} placeholder="space-id" />
          <div class="flex flex-wrap gap-2 mt-2">
            {#each Object.entries(NSIDS) as [label, nsid]}
              <Button onclick={() => onSpaceQuery(nsid, label)} disabled={loading || !spaceId.trim()}>{label}</Button>
            {/each}
          </div>
        </div>

        <!-- Room queries -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Room Queries</h3>
          <label for="room-id" class="block text-xs mb-1">Room ID</label>
          <Input id="room-id" bind:value={roomId} placeholder="room-id" />
          <div class="flex flex-wrap gap-2 mt-2">
            {#each Object.entries(NSIDS) as [label, nsid]}
              <Button onclick={() => onRoomQuery(nsid, label)} disabled={loading || !roomId.trim()}>{label}</Button>
            {/each}
          </div>
        </div>

        <!-- Message queries -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Message Queries</h3>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label for="message-limit" class="block text-xs mb-1">Limit</label>
              <Input id="message-limit" bind:value={messageLimit} />
            </div>
            <div>
              <label for="message-cursor" class="block text-xs mb-1">Cursor</label>
              <Input id="message-cursor" bind:value={messageCursor} />
            </div>
            <div>
              <label for="message-id" class="block text-xs mb-1">Message ID</label>
              <Input id="message-id" bind:value={messageId} />
            </div>
          </div>
          <div class="flex flex-wrap gap-2 mt-2">
            <Button onclick={onGetMessages} disabled={loading || !roomId.trim()}>Get Messages</Button>
            <Button onclick={onGetMessage} disabled={loading || !messageId.trim()}>Get Message</Button>
          </div>
        </div>

        <!-- Result output -->
        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Result</h3>
          <pre class="p-3 rounded-2xl text-sm whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto {resultError ? 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300' : 'bg-base-100 dark:bg-base-900/50 text-base-600 dark:text-base-400'}">{result}</pre>
        </div>
      </details>
    </section>

    <!-- ─── WebSocket Sync ──────────────────────────────────────────────── -->
    <section class="mb-6">
      <details>
        <summary class="text-lg font-semibold cursor-pointer mb-3">WebSocket Sync</summary>

        <div class="mb-4">
          <label for="ws-url" class="block text-xs mb-1">WebSocket URL</label>
          <Input id="ws-url" bind:value={wsUrl} />
          <div class="flex flex-wrap gap-2 mt-2">
            <Button onclick={onWsConnect} disabled={loading || !wsUrl.trim() || wsConnected}>Connect</Button>
            <Button onclick={onWsDisconnect} disabled={!wsConnected}>Disconnect</Button>
          </div>
        </div>

        <div class="mb-4">
          <h3 class="text-sm font-medium text-base-500 mb-2">Subscribe</h3>
          <div class="flex items-center gap-2 mb-2">
            <label class="flex items-center gap-1 text-sm">
              <input type="radio" bind:group={wsSubTopic} value="space" />
              Space
            </label>
            <label class="flex items-center gap-1 text-sm">
              <input type="radio" bind:group={wsSubTopic} value="room" />
              Room
            </label>
          </div>
          <label for="ws-sub-id" class="block text-xs mb-1">ID</label>
          <Input id="ws-sub-id" bind:value={wsSubId} placeholder="did:plc:... or room-id" />
          <div class="flex flex-wrap gap-2 mt-2">
            <Button onclick={onWsSub} disabled={!wsConnected || !wsSubId.trim()}>Subscribe</Button>
            <Button onclick={onWsUnsub} disabled={!wsConnected || !wsSubId.trim()}>Unsubscribe</Button>
            <Button onclick={onWsCursor} disabled={!wsConnected}>Send Cursor</Button>
            <Button variant="ghost" onclick={onWsClearLog}>Clear Log</Button>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-medium text-base-500 mb-2">Event Log</h3>
          <div class="bg-base-100 dark:bg-base-900/50 rounded-2xl p-3 max-h-64 overflow-y-auto">
            {#each wsLog as line}
              <pre class="text-xs leading-relaxed whitespace-pre-wrap">{line}</pre>
            {/each}
          </div>
        </div>
      </details>
    </section>

    <!-- ─── Feature Flags ──────────────────────────────────────────────── -->
    <section class="mb-6">
      <details>
        <summary class="text-lg font-semibold cursor-pointer mb-3">Feature Flags</summary>

        <div class="mb-4">
          <Button onclick={refreshFlags} disabled={flagLoading}>
            {flagLoading ? "Loading…" : "Refresh Flags"}
          </Button>
        </div>

        {#if flags === null}
          <p class="text-sm text-base-500">Click "Refresh Flags" to load registered feature flags.</p>
        {:else if flags.length === 0}
          <p class="text-sm text-base-500">No feature flags are registered in the code registry.</p>
        {:else}
          {#each flags as flag (flag.key)}
            <div class="border border-base-200 dark:border-base-800 rounded-2xl p-4 mb-4 bg-white dark:bg-base-900/50">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <h4 class="font-mono text-sm font-semibold">{flag.key}</h4>
                  <p class="text-xs text-base-500">{flag.description || "(no description)"}</p>
                </div>
                <div class="flex items-center gap-2">
                  <label class="flex items-center gap-1 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={flag.globalEnabled}
                      onchange={() => onFlagToggleGlobal(flag.key, flag.globalEnabled)}
                      disabled={flagLoading}
                    />
                    Enable for all
                  </label>
                  <Button
                    variant="ghost"
                    onclick={() => onFlagClear(flag.key)}
                    disabled={flagLoading}
                  >Clear</Button>
                </div>
              </div>

              <div>
                <label class="block text-xs mb-1">Assigned DIDs (one per line)</label>
                <textarea
                  class="w-full text-sm p-2 border border-base-200 dark:border-base-800 rounded-xl bg-white dark:bg-base-900/50 text-base-800 dark:text-base-200 font-mono"
                  rows="3"
                  placeholder="did:plc:abc..."
                  value={flagDidsInput[flag.key] ?? flag.assignedDids.join("\n")}
                  oninput={(e) => { flagDidsInput[flag.key] = (e.target as HTMLTextAreaElement).value; }}
                ></textarea>
                <div class="mt-2">
                  <Button
                    onclick={() => onFlagSaveDids(flag.key)}
                    disabled={flagLoading}
                  >Save DIDs</Button>
                </div>
              </div>
            </div>
          {/each}
        {/if}
      </details>
    </section>
  {/if}
</div>
