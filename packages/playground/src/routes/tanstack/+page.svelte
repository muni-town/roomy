<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { createQuery, QueryClientProvider } from "@tanstack/svelte-query";
	import Button from "@roomy/design/components/ui/button/Button.svelte";
	import Input from "@roomy/design/components/ui/input/Input.svelte";
	import { queryClient } from "$lib/queries/query-client";
	import {
		NSID,
		fetchGetSpaces,
		fetchSpaceMetadata,
		fetchRoomMetadata,
		fetchMessages,
		fetchTicket,
		callUpdateSeenRoom,
	} from "$lib/queries/xrpc-queries";
	import { createSyncConnection } from "$lib/queries/sync.svelte";
	import {
		initSession,
		login,
		logout,
		loadAppserverDid,
		saveAppserverDid,
	} from "@roomy-space/sdk/browser";
	import type { Agent } from "@atproto/api";
	import type { OAuthSession } from "@roomy-space/sdk/browser";
	import { schemas } from "@roomy-space/sdk";
	type Space = typeof schemas.queries.getSpaces.Space.infer;
	type SidebarChannel = typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;
	type Message = typeof schemas.queries.getMessages.Message.infer;

	// ── Auth state ──────────────────────────────────────────────────────

	let authenticated = $state(false);
	let agent: Agent | null = $state(null);
	let session: OAuthSession | null = $state(null);
	let appserverDid = $state(loadAppserverDid());
	let handle = $state("");
	let initError = $state("");

	// ── Navigation state ────────────────────────────────────────────────

	let selectedSpaceId = $state<string | null>(null);
	let selectedRoomId = $state<string | null>(null);

	// ── Sync state ──────────────────────────────────────────────────────

	let syncLog = $state<string[]>([]);
	let syncConn = $state<ReturnType<typeof createSyncConnection> | null>(null);

	function appendLog(msg: string) {
		const time = new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
		untrack(() => {
			syncLog = [...syncLog, `[${time}] ${msg}`];
		});
	}

	// ── Mark room as seen ───────────────────────────────────────────────

	async function markRoomSeen(roomId: string) {
		if (!agent) return;
		try {
			await callUpdateSeenRoom(agent, appserverDid, roomId)();
			appendLog(`updateSeen → ${roomId.slice(0, 8)}…`);
		} catch (err: any) {
			appendLog(`updateSeen error: ${err?.message ?? err}`);
		}
	}

	// ── Init ────────────────────────────────────────────────────────────

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

	// ── Login/logout ────────────────────────────────────────────────────

	async function handleLogin() {
		if (!handle.trim() || !appserverDid.trim()) return;
		saveAppserverDid(appserverDid.trim());
		await login(appserverDid.trim(), handle.trim());
	}

	async function handleLogout() {
		if (session) await logout(session);
		location.reload();
	}

	// ── Auto-connect sync when authenticated ────────────────────────────

	$effect(() => {
		if (!authenticated || !agent) return;

		const conn = createSyncConnection({
			queryClient,
			fetchTicket: fetchTicket(agent, appserverDid),
			appserverDid,
			onLog: appendLog,
			onMessageDiff: (roomId, _seq) => {
				// If a message arrives in the currently-open room, mark it as seen
				untrack(() => {
					if (selectedRoomId === roomId) {
						markRoomSeen(roomId);
					}
				});
			},
		});
		syncConn = conn;
		conn.connect();

		return () => {
			conn.disconnect();
		};
	});

	// ── Auto-subscribe to visible data ──────────────────────────────────

	$effect(() => {
		const conn = syncConn;
		if (!conn || conn.state !== "connected") return;

		// Always subscribe to spaces (for getSpaces invalidations)
		// Subscribe to selected space (for sidebar + metadata)
		if (selectedSpaceId) {
			conn.subscribe("space", selectedSpaceId);
		}
		// Subscribe to selected room (for message diffs)
		if (selectedRoomId) {
			conn.subscribe("room", selectedRoomId);
		}
	});

	// ── Mark room as seen when opened ───────────────────────────────────

	$effect(() => {
		const roomId = selectedRoomId;
		if (!roomId || !agent) return;
		markRoomSeen(roomId);
	});
</script>

<QueryClientProvider client={queryClient}>
	<div class="h-screen flex flex-col bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
		{#if initError}
			<pre class="text-red-800 bg-red-50 p-3 m-4 rounded-2xl text-sm whitespace-pre-wrap">{initError}</pre>
		{:else if !authenticated}
			{@render loginScreen()}
		{:else}
			{@render appShell()}
		{/if}
	</div>
</QueryClientProvider>

<!-- ─── Login screen ──────────────────────────────────────────────────── -->

{#snippet loginScreen()}
<div class="flex-1 flex items-center justify-center">
	<div class="w-full max-w-sm px-4">
		<h1 class="text-2xl font-bold mb-1">Roomy Playground</h1>
		<p class="text-base-500 dark:text-base-400 mb-6 text-sm">TanStack Query + WS Sync prototype</p>

		<label for="appserver-did" class="block mb-1 font-medium text-sm">Appserver DID</label>
		<Input id="appserver-did" bind:value={appserverDid} />

		<label for="handle" class="block mt-3 mb-1 font-medium text-sm">ATProto handle</label>
		<Input id="handle" placeholder="user.bsky.social" bind:value={handle} />

		<Button class="mt-4 w-full" onclick={handleLogin} disabled={!handle.trim() || !appserverDid.trim()}>
			Login
		</Button>
	</div>
</div>
{/snippet}

<!-- ─── App shell ─────────────────────────────────────────────────────── -->

{#snippet appShell()}
<div class="flex-1 flex flex-col overflow-hidden">
	<!-- Top bar -->
	<header class="flex items-center justify-between px-4 py-2 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900 shrink-0">
		<div class="flex items-center gap-3">
			<span class="font-bold text-lg">Roomy</span>
			<span class="text-sm text-base-500 dark:text-base-400">TanStack Query prototype</span>
		</div>
		<div class="flex items-center gap-2">
			{@render syncBadge(syncConn?.state ?? "disconnected")}
			<Button variant="ghost" size="sm" onclick={handleLogout}>Logout</Button>
		</div>
	</header>

	<!-- Main content: sidebar + room -->
	<div class="flex-1 flex overflow-hidden">
		{@render sidebar()}
		<main class="flex-1 flex flex-col overflow-hidden">
			{#if selectedRoomId}
				{@render roomView()}
			{:else}
				<div class="flex-1 flex items-center justify-center text-base-400 dark:text-base-500">
					<div class="text-center">
						<p class="text-lg font-medium mb-1">No room selected</p>
						<p class="text-sm">Pick a channel from the sidebar to start chatting</p>
					</div>
				</div>
			{/if}
		</main>
	</div>

	<!-- Sync log (collapsible) -->
	{@render syncLogPanel()}
</div>
{/snippet}

<!-- ─── Sidebar ───────────────────────────────────────────────────────── -->

{#snippet sidebar()}
<aside class="w-64 shrink-0 border-r border-base-200 dark:border-base-800 bg-white dark:bg-base-900 flex flex-col overflow-hidden">
	<div class="p-3 border-b border-base-200 dark:border-base-800">
		<h2 class="font-semibold text-sm">Spaces</h2>
	</div>

	{#if agent}
		{@render spaceList()}
	{/if}
</aside>
{/snippet}

{#snippet spaceList()}
{@const spacesQuery = createQuery(() => ({
	queryKey: [NSID.GET_SPACES, {}],
	queryFn: fetchGetSpaces(agent!, appserverDid),
}))}

{#if spacesQuery.isPending}
	<div class="p-3 text-sm text-base-400">Loading spaces…</div>
{:else if spacesQuery.isError}
	<div class="p-3 text-sm text-red-600">Error: {spacesQuery.error.message}</div>
{:else if spacesQuery.data}
	{@const spaces = spacesQuery.data.spaces}
	<div class="flex-1 overflow-y-auto">
		{#each spaces as space (space.id)}
			{@render spaceItem(space)}
		{/each}
		{#if spaces.length === 0}
			<p class="p-3 text-sm text-base-400">No spaces found.</p>
		{/if}
	</div>
{/if}
{/snippet}

{#snippet spaceItem(space: Space)}
<button
	class="w-full text-left px-3 py-2 hover:bg-base-100 dark:hover:bg-base-800 transition-colors {selectedSpaceId === space.id ? 'bg-accent-50 dark:bg-accent-950/20 border-l-2 border-accent-500' : ''}"
	onclick={() => {
		selectedSpaceId = space.id;
		selectedRoomId = null;
	}}
>
	<div class="flex items-center justify-between">
		<span class="font-medium text-sm truncate">{space.name || space.id.slice(0, 12) + '…'}</span>
		{#if space.unreadCount > 0}
			<span class="bg-accent-500 text-white text-xs px-1.5 py-0.5 rounded-full font-medium min-w-[20px] text-center">
				{space.unreadCount}
			</span>
		{/if}
	</div>
	<div class="flex gap-1 mt-0.5">
		{#if space.isMember}
			<span class="text-[10px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">member</span>
		{/if}
		{#if space.isAdmin}
			<span class="text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">admin</span>
		{/if}
	</div>
</button>

{#if selectedSpaceId === space.id}
	{@render channelList(space.id)}
{/if}
{/snippet}

{#snippet channelList(spaceId: string)}
{@const metadataQuery = createQuery(() => ({
	queryKey: [NSID.GET_SPACE_METADATA, { spaceId }],
	queryFn: fetchSpaceMetadata(agent!, appserverDid, spaceId),
}))}

{#if metadataQuery.isPending}
	<div class="px-6 py-1 text-xs text-base-400">Loading sidebar…</div>
{:else if metadataQuery.data}
	{@const sidebar = metadataQuery.data.sidebar}
	<div class="border-l-2 border-base-200 dark:border-base-700 ml-3">
		{#each sidebar.categories as category}
			<div class="px-3 pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">
				{category.name}
			</div>
			{#each category.channels as channel}
				{@render channelItem(channel)}
			{/each}
		{/each}
		{#if sidebar.orphans.length > 0}
			{#each sidebar.orphans as channel}
				{@render channelItem(channel)}
			{/each}
		{/if}
	</div>
{:else if metadataQuery.isError}
	<div class="px-6 py-1 text-xs text-red-500">{metadataQuery.error.message}</div>
{/if}
{/snippet}

{#snippet channelItem(channel: SidebarChannel)}
<button
	class="w-full text-left px-4 py-1.5 hover:bg-base-100 dark:hover:bg-base-800 text-sm transition-colors flex items-center justify-between group {selectedRoomId === channel.id ? 'bg-accent-50 dark:bg-accent-950/20 font-medium' : ''}"
	onclick={() => {
		selectedRoomId = channel.id;
	}}
	disabled={!channel.canRead}
>
	<span class="truncate {channel.canRead ? '' : 'text-base-400 dark:text-base-500 opacity-50'}">
		{#if !channel.canWrite && channel.canRead}
			🔒
		{/if}
		{channel.name}
	</span>
	{#if channel.unreadCount > 0}
		<span class="bg-accent-500 text-white text-[10px] px-1 py-0.5 rounded-full font-medium">
			{channel.unreadCount}
		</span>
	{/if}
</button>
{/snippet}

<!-- ─── Room view ─────────────────────────────────────────────────────── -->

{#snippet roomView()}
{@const roomMetaQuery = createQuery(() => ({
	queryKey: [NSID.GET_ROOM_METADATA, { roomId: selectedRoomId! }],
	queryFn: fetchRoomMetadata(agent!, appserverDid, selectedRoomId!),
}))}

{#if roomMetaQuery.isPending}
	<div class="flex-1 flex items-center justify-center text-base-400">Loading room…</div>
{:else if roomMetaQuery.data}
	{@const room = roomMetaQuery.data}

	<!-- Room header -->
	<div class="px-4 py-2 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900 flex items-center justify-between shrink-0">
		<div>
			<h2 class="font-semibold">{room.name}</h2>
			<span class="text-xs text-base-400">{room.kind} · {room.canWrite ? 'can write' : 'read only'}</span>
		</div>
		{#if room.unreadCount > 0}
			<span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
				{room.unreadCount} unread
			</span>
		{/if}
	</div>

	<!-- Messages -->
	{@render messageList(selectedRoomId!)}
{:else if roomMetaQuery.isError}
	<div class="flex-1 flex items-center justify-center text-red-500">{roomMetaQuery.error.message}</div>
{/if}
{/snippet}

{#snippet messageList(roomId: string)}
{@const messagesQuery = createQuery<Message[]>(() => ({
	queryKey: [NSID.GET_MESSAGES, { roomId }],
	queryFn: async () => {
		const res = await fetchMessages(agent!, appserverDid, roomId, 50)();
		return res.messages;
	},
}))}

{#if messagesQuery.isPending}
	<div class="flex-1 flex items-center justify-center text-base-400">Loading messages…</div>
{:else if messagesQuery.data}
	<div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
		{#if messagesQuery.data.length === 0}
			<p class="text-center text-base-400 text-sm py-8">No messages yet</p>
		{/if}
		{#each messagesQuery.data as message (message.id)}
			{@render messageBubble(message)}
		{/each}
	</div>
{:else if messagesQuery.isError}
	<div class="flex-1 flex items-center justify-center text-red-500">{messagesQuery.error.message}</div>
{/if}

{#if messagesQuery.isFetching && messagesQuery.data}
	<div class="px-4 py-1 text-xs text-center text-base-400 animate-pulse">Updating…</div>
{/if}
{/snippet}

{#snippet messageBubble(message: Message)}
<div class="flex gap-2.5 group">
	<!-- Avatar placeholder -->
	<div class="w-8 h-8 rounded-full bg-base-200 dark:bg-base-700 shrink-0 flex items-center justify-center text-xs font-bold text-base-500">
		{(message.authorName || "?")[0]?.toUpperCase() ?? "?"}
	</div>
	<div class="flex-1 min-w-0">
		<div class="flex items-baseline gap-2">
			<span class="font-medium text-sm">{message.authorName || message.authorDid.slice(0, 12)}</span>
			<span class="text-[11px] text-base-400">
				{new Date(message.timestamp).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit" })}
			</span>
		</div>
		<p class="text-sm whitespace-pre-wrap break-words">{message.content}</p>
		{#if message.reactions.length > 0}
			<div class="flex gap-1 mt-1">
				{#each message.reactions as reaction}
					<span class="text-xs bg-base-100 dark:bg-base-800 px-1.5 py-0.5 rounded-full">
						{reaction.emoji} {reaction.dids.length}
					</span>
				{/each}
			</div>
		{/if}
	</div>
</div>
{/snippet}

<!-- ─── Sync log panel ────────────────────────────────────────────────── -->

{#snippet syncLogPanel()}
{#if syncLog.length > 0}
	<details class="border-t border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
		<summary class="px-4 py-1.5 text-xs font-medium text-base-500 dark:text-base-400 cursor-pointer hover:bg-base-100 dark:hover:bg-base-800">
			Sync log ({syncLog.length})
		</summary>
		<div class="max-h-40 overflow-y-auto px-4 pb-2 text-[11px] font-mono text-base-500 dark:text-base-400">
			{#each syncLog.slice(-100) as line}
				<div class="py-0.5 whitespace-pre-wrap">{line}</div>
			{/each}
		</div>
		<div class="px-4 pb-2">
			<button
				class="text-[11px] text-base-400 hover:text-base-600"
				onclick={() => { syncLog = []; }}
			>Clear</button>
		</div>
	</details>
{/if}
{/snippet}

{#snippet syncBadge(connState: string)}
<span
	class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium {connState === 'connected'
		? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
		: connState === 'connecting'
			? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
			: 'bg-base-200 dark:bg-base-800 text-base-500 dark:text-base-400'
	}"
>
	<span class="w-1.5 h-1.5 rounded-full {connState === 'connected'
		? 'bg-emerald-500'
		: connState === 'connecting'
			? 'bg-amber-500 animate-pulse'
			: 'bg-base-400'
	}"></span>
	{connState === "connected" ? "Live" : connState === "connecting" ? "Connecting\u2026" : "Offline"}
</span>
{/snippet}
