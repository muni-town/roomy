<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import { page } from "$app/state";
  import { toast } from "@foxui/core";
  import Badge from "@roomy/design/components/ui/badge/Badge.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import InlineMono from "@roomy/design/components/helper/InlineMono.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import {
    IconAlertCircle,
    IconCheck,
    IconChevronRight,
    IconCopy,
    IconHashtag,
    IconHourglassHigh,
    IconHourglassMedium,
    IconNeedleThread,
  } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createMembersQuery } from "$lib/queries/members";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { createMembershipStatusQuery } from "$lib/queries/membership-status";
  import { createBridgeTokensQuery } from "$lib/queries/bridge-tokens";
  import {
    grantBridgeToken,
    revokeBridgeToken,
    xrpcErrorName,
  } from "$lib/mutations/bridge-tokens";
  import { sendEvents } from "$lib/mutations/send-events";
  import { auth } from "$lib/auth.svelte";
  import { newUlid, type UserDid, type Event } from "@roomy-space/sdk";
  import { setSpaceInfoExtra } from "$lib/components/layout/navbar.svelte";
  import { FREE_BRIDGE_MEMBER_LIMIT } from "$lib/config";

  const spaceId = $derived(page.params.space!);

  // Fetch members to check if the bridge bot has admin access
  const membersQuery = createMembersQuery(() => spaceId);

  const bridgeBotDid = $derived(env.PUBLIC_BRIDGE_DID);

  const hasAdminAccess = $derived(
    (membersQuery.data?.members ?? []).some(
      (m) => m.did === bridgeBotDid && m.isAdmin,
    ) ||
      (membersQuery.data?.externalAdmins ?? []).some(
        (ea) => ea.did === bridgeBotDid,
      ),
  );

  // ── Roomy Pro membership ──────────────────────────────────────────────
  // The Discord Bridge settings tab is only visible when the caller has the
  // pro-subscription flag (see SpaceSidebar); direct navigation can still
  // reach this page, so the Pro panel below degrades to a gated notice.
  const flagsQuery = createFeatureFlagsQuery();
  const proEnabled = $derived(
    flagsQuery.data?.flags.includes("pro-subscription") ?? false,
  );

  // The caller's Pro membership: capacity 0 means not a Pro member (or Polar
  // unreachable with nothing cached — `stale`).
  const statusQuery = createMembershipStatusQuery(() => undefined);
  const status = $derived(statusQuery.data);
  const isProMember = $derived((status?.capacity ?? 0) > 0);

  // Grants for THIS space. Only fetched once the caller is known to be a
  // member (the query 403s otherwise) and they're a Pro member (nobody else
  // can grant). `getBridgeTokens` reports the grant-time capacity snapshot,
  // not live validity.
  const tokensQuery = createBridgeTokensQuery(() => spaceId, {
    enabled: () => proEnabled && isProMember,
  });
  const myGrant = $derived(
    (tokensQuery.data?.tokens ?? []).find(
      (t) => t.grantorDid === auth.userDid,
    ),
  );

  let tokenBusy = $state(false);

  async function onUseMembership() {
    if (tokenBusy) return;
    tokenBusy = true;
    try {
      await grantBridgeToken(spaceId);
      toast.success("Your Roomy Pro membership now powers this space.");
    } catch (err) {
      const name = xrpcErrorName(err);
      if (name === "AlreadyGranted") {
        toast.error(
          "You've already used your membership on another space. Free it there first.",
        );
      } else if (name === "AlreadySpent") {
        toast.error("This membership is already permanently used.");
      } else if (name === "NotProMember") {
        toast.error("Roomy Pro isn't active on your account.");
      } else {
        toast.error("Couldn't use your membership here. Please try again.");
      }
      console.error("grantBridgeToken failed:", err);
    } finally {
      tokenBusy = false;
    }
  }

  async function onStopUsingMembership() {
    if (tokenBusy) return;
    tokenBusy = true;
    try {
      await revokeBridgeToken(spaceId);
      toast.success("Your Roomy Pro membership is free to use elsewhere.");
    } catch (err) {
      const name = xrpcErrorName(err);
      if (name === "AlreadySpent") {
        toast.error(
          "This membership is permanently in use and can't be taken back.",
        );
      } else {
        toast.error("Couldn't free your membership. Please try again.");
      }
      console.error("revokeBridgeToken failed:", err);
    } finally {
      tokenBusy = false;
    }
  }

  let bridgeStatus:
    | { type: "checking" }
    | {
        type: "loaded";
        guildId: undefined | string;
        appId: string;
      }
    | { type: "error_checking" } = $state({ type: "checking" });

  // Per-channel backfill progress from the bridge REST surface. Polled while
  // the space is bridged; survives restarts because the bridge persists the
  // rows (phase, counts, cursor) in SQLite.
  type BackfillProgressEntry = {
    spaceDid: string;
    channelId: string;
    guildId: string | null;
    kind: "channel" | "thread" | null;
    channelName: string | null;
    phase: "phase1" | "phase2" | "complete" | "blocked";
    messagesSynced: number;
    messagesSkipped: number;
    cursor: string | null;
    // Thread rows only: Discord id of the parent channel (panel nesting).
    parentId: string | null;
    // Recent-window size at the phase1→phase2 transition (bridge snapshot).
    windowSynced: number | null;
    // Blocked rows only: why the bridge can't read this channel.
    blockedReason: string | null;
    roomyId: string | null;
    running: boolean;
    updatedAt: number;
  };
  let backfillChannels = $state<BackfillProgressEntry[]>([]);
  let backfillError = $state(false);

  // The panel mirrors the space's sidebar: categories (by position) → channels
  // (in order) → active threads nested under their parent, then orphan
  // channels (+ their threads), then anything the sidebar doesn't know yet —
  // channels before threads. The bridge's up-front enumeration makes the panel
  // listable immediately; archived threads appear only once the background walk
  // discovers them and lands at the end.
  const spaceMetaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: () => !!spaceId,
  });

  const sidebarSlots = $derived.by(() => {
    const cats = spaceMetaQuery.data?.sidebar.categories ?? [];
    const orphans = spaceMetaQuery.data?.sidebar.orphans ?? [];
    const slots: Array<{ roomyId: string; parentRoomId: string | null }> = [];
    for (const cat of [...cats].sort((a, b) => a.position - b.position)) {
      for (const ch of cat.channels) {
        slots.push({ roomyId: ch.id, parentRoomId: null });
        for (const thread of ch.activeThreads ?? []) {
          slots.push({ roomyId: thread.id, parentRoomId: ch.id });
        }
      }
    }
    for (const ch of orphans) {
      slots.push({ roomyId: ch.id, parentRoomId: null });
      for (const thread of ch.activeThreads ?? []) {
        slots.push({ roomyId: thread.id, parentRoomId: ch.id });
      }
    }
    return slots;
  });

  const orderedBackfillRows = $derived.by(() => {
    type Row = {
      entry: BackfillProgressEntry;
      parentRoomId: string | null;
    };
    const rows: Row[] = [];
    const roomKey = (e: BackfillProgressEntry) => e.roomyId ?? e.channelId;
    const entryByRoom = new Map(backfillChannels.map((e) => [roomKey(e), e]));
    const placed = new Set<string>();

    // Sidebar order first (channels + their active threads).
    for (const slot of sidebarSlots) {
      const entry = entryByRoom.get(slot.roomyId);
      if (!entry) continue;
      rows.push({ entry, parentRoomId: slot.parentRoomId });
      placed.add(entry.channelId);
    }
    // Everything else (structure not synced yet, archived threads the
    // background walk just found): channels first, then threads, each group in
    // API order (newest update first) — a thread never leads the list while a
    // channel is still pending. Threads nest under their parent entry when it
    // has one of its own.
    const rest = backfillChannels.filter((e) => !placed.has(e.channelId));
    const leftovers = [
      ...rest.filter((e) => e.kind !== "thread"),
      ...rest.filter((e) => e.kind === "thread"),
    ];
    for (const entry of leftovers) {
      const parent = entry.parentId
        ? backfillChannels.find((e) => e.channelId === entry.parentId)
        : undefined;
      rows.push({ entry, parentRoomId: parent ? roomKey(parent) : null });
    }
    return rows;
  });

  // Threads nest under the rendered parent channel; a thread whose parent
  // has no entry of its own stays top-level.
  const backfillChildren = $derived.by(() => {
    const map = new Map<string, BackfillProgressEntry[]>();
    const roomIds = new Set(
      orderedBackfillRows.map((r) => r.entry.roomyId ?? r.entry.channelId),
    );
    for (const row of orderedBackfillRows) {
      if (!row.parentRoomId || !roomIds.has(row.parentRoomId)) continue;
      const list = map.get(row.parentRoomId) ?? [];
      list.push(row.entry);
      map.set(row.parentRoomId, list);
    }
    return map;
  });

  const topLevelBackfillRows = $derived(
    orderedBackfillRows.filter((r) => !r.parentRoomId),
  );

  const backfillSummary = $derived.by(() => {
    let complete = 0;
    let pending = 0;
    let running = 0;
    let blocked = 0;
    for (const e of backfillChannels) {
      if (e.phase === "complete") complete++;
      // A blocked channel isn't work in flight — the bridge can't read it —
      // so it never counts as pending.
      else if (e.phase === "blocked") blocked++;
      else pending++;
      if (e.running) running++;
    }
    return { complete, pending, running, blocked };
  });

  let backfillOpen = $state(true);

  async function updateBackfillProgress() {
    try {
      const resp = await fetch(
        `${env.PUBLIC_DISCORD_BRIDGE}/backfill/progress?spaceDid=${spaceId}`,
      );
      if (!resp.ok) {
        backfillError = true;
        return;
      }
      const data: { channels: BackfillProgressEntry[] } = await resp.json();
      backfillChannels = data.channels;
      backfillError = false;
    } catch {
      backfillError = true;
    }
  }

  async function updateBridgeStatus() {
    if (!spaceId) return;
    try {
      const aResp = await fetch(`${env.PUBLIC_DISCORD_BRIDGE}/info`);
      const info:
        | { discordAppId: string; bridgeDid: string }
        | { error: string; status: number } = await aResp.json();
      if ("error" in info) {
        console.error("Couldn't fetch Discord app ID from bridge.");
        bridgeStatus = { type: "error_checking" };
        return;
      }
      const gResp = await fetch(
        `${env.PUBLIC_DISCORD_BRIDGE}/get-guild-id?spaceId=${spaceId}`,
      );
      // 404 means no guild is connected yet — that's expected for unconnected spaces
      let guildId: string | undefined;
      if (gResp.ok) {
        const data: { guildId?: string } = await gResp.json();
        guildId = data.guildId;
      }

      bridgeStatus = {
        type: "loaded",
        appId: info.discordAppId,
        guildId,
      };
    } catch (e) {
      bridgeStatus = { type: "error_checking" };
    }
  }

  async function grantBotPermissions() {
    if (!spaceId) {
      toast.error("No space selected");
      return;
    }

    try {
      // Send addAdmin event to make the bridge bot an admin
      const events: Event[] = [
        {
          id: newUlid(),
          $type: "space.roomy.space.addAdmin.v0",
          userDid: env.PUBLIC_BRIDGE_DID as UserDid,
        },
      ];

      await sendEvents(spaceId, events);

      toast.success("Successfully granted bot permissions.");

      // Refresh members query to reflect the change
      membersQuery.refetch();
    } catch (error) {
      console.error("Failed to grant bot permissions:", error);
      toast.error("Failed to grant bot permissions. Please try again.");
    }
  }

  async function revokeBotPermissions() {
    if (!spaceId) {
      toast.error("No space selected");
      return;
    }

    try {
      // Send removeAdmin event to revoke bridge bot admin access
      const events: Event[] = [
        {
          id: newUlid(),
          $type: "space.roomy.space.removeAdmin.v0",
          userDid: env.PUBLIC_BRIDGE_DID as UserDid,
        },
      ];

      await sendEvents(spaceId, events);

      toast.success("Revoked bot permissions.");

      // Refresh members query to reflect the change
      membersQuery.refetch();
    } catch (error) {
      console.error("Failed to revoke bot permissions:", error);
      toast.error("Failed to revoke bot permissions. Please try again.");
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard", { position: "bottom-right" });
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  }

  // Reload app when this module changes to prevent stacking the setIntervals
  if (import.meta.hot) {
    import.meta.hot.accept(() => {
      window.location.reload();
    });
  }

  $effect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const updateStatus = () => {
      if (document.visibilityState === "visible") {
        updateBridgeStatus();
        clearInterval(interval);
        interval = setInterval(updateStatus, 8000);
      } else {
        clearInterval(interval);
      }
    };
    updateStatus();
    document.addEventListener("visibilitychange", updateStatus);

    return () => {
      document.removeEventListener("visibilitychange", updateStatus);
      clearInterval(interval);
    };
  });

  // Poll backfill progress at a tighter cadence while bridged. Re-runs when
  // bridgeStatus flips to loaded (it's read here), so the timer only exists
  // once the space is actually bridged.
  $effect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const updateProgress = () => {
      if (
        document.visibilityState === "visible" &&
        bridgeStatus.type === "loaded" &&
        bridgeStatus.guildId
      ) {
        updateBackfillProgress();
        clearInterval(interval);
        interval = setInterval(updateProgress, 5000);
      } else {
        clearInterval(interval);
      }
    };
    updateProgress();
    document.addEventListener("visibilitychange", updateProgress);

    return () => {
      document.removeEventListener("visibilitychange", updateProgress);
      clearInterval(interval);
    };
  });

  onMount(() => {
    // Surface the live bridge connection status badge in the navbar, next to
    // the "Discord Bridge" settings title.
    setSpaceInfoExtra(bridgeStatusBadge);
    return () => setSpaceInfoExtra(undefined);
  });
</script>

{#snippet bridgeStatusBadge()}
  {#if bridgeStatus.type === "checking"}
    <Badge variant="yellow">checking</Badge>
  {:else if bridgeStatus.type === "loaded"}
    {#if bridgeStatus.guildId}
      <Badge variant="green">bridged</Badge>
    {:else}
      <Badge>not bridged</Badge>
    {/if}
  {:else if bridgeStatus.type === "error_checking"}
    <Badge variant="red">error connecting to bridge</Badge>
  {/if}
{/snippet}

{#snippet backfillStatusPanel()}
  <section
    class="rounded-lg border border-base-200 dark:border-base-800 px-4 py-3"
  >
    {#if backfillError}
      <p class="text-sm text-base-600 dark:text-base-400">
        Couldn't load backfill progress right now.
      </p>
    {:else if backfillChannels.length === 0}
      <h2 class="text-sm font-semibold text-base-900 dark:text-base-100">
        Backfill status
      </h2>
      <p class="mt-1 text-sm text-base-600 dark:text-base-400">
        No channels backfilled yet — history syncs shortly after bridging.
      </p>
    {:else}
      <!-- Collapsible summary line: overall state up top, detail below. -->
      <button
        type="button"
        class="flex w-full items-center justify-between gap-3 text-left"
        onclick={() => (backfillOpen = !backfillOpen)}
        aria-expanded={backfillOpen}
      >
        <span class="text-sm font-semibold text-base-900 dark:text-base-100">
          Backfill status
        </span>
        <span class="flex items-center gap-2 text-xs text-base-500 dark:text-base-400">
          {#if backfillSummary.pending === 0 && backfillSummary.blocked === 0}
            <span class="font-medium text-green-600 dark:text-green-400">
              all synced
            </span>
          {:else}
            <span class="flex items-center gap-1">
              <span>{backfillSummary.complete} complete</span>
              {#if backfillSummary.pending > 0}
                <span>· {backfillSummary.pending} pending</span>
              {/if}
              {#if backfillSummary.blocked > 0}
                <span class="text-red-600 dark:text-red-400">
                  · {backfillSummary.blocked} unreadable
                </span>
              {/if}
            </span>
            {#if backfillSummary.running > 0}
              <LoadingSpinner size={12} />
            {/if}
          {/if}
          <IconChevronRight
            font-size={14}
            class={backfillOpen
              ? "rotate-90 text-base-500 dark:text-base-400"
              : "text-base-500 dark:text-base-400"}
            style="transition: transform 120ms"
          />
        </span>
      </button>

      {#if backfillOpen}
        <ul class="mt-2 space-y-1.5">
          {#each topLevelBackfillRows as row (row.entry.spaceDid + row.entry.channelId)}
            {@render progressRow(row.entry, false)}
            {#each backfillChildren.get(row.entry.roomyId ?? row.entry.channelId) ?? [] as child (child.spaceDid + child.channelId)}
              {@render progressRow(child, true)}
            {/each}
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
{/snippet}

{#snippet progressRow(entry: BackfillProgressEntry, nested: boolean)}
  <li
    class={nested
      ? "ms-7 flex items-center justify-between gap-4 text-sm"
      : "flex items-center justify-between gap-4 text-sm"}
  >
    <span class="flex min-w-0 items-center gap-2">
      {#if entry.kind === "thread"}
        <IconNeedleThread
          class="shrink-0 text-base-400 dark:text-base-500"
          font-size={15}
        />
      {:else}
        <IconHashtag
          class="shrink-0 text-base-400 dark:text-base-500"
          font-size={15}
        />
      {/if}
      <span class="truncate text-base-900 dark:text-base-100">
        {entry.channelName ?? entry.channelId}
      </span>
    </span>
    <span class="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span class="text-xs tabular-nums text-base-500 dark:text-base-400">
        {entry.messagesSynced} synced
      </span>
      <!--
        Row state is icon-only; the accessible name spells it out. The synced
        count is the one number that stays.
          blocked           → alert / "can't backfill: <reason>"
          running (phase 1) → spinner / "backfilling recent history"
          running (phase 2) → spinner / "deep backfill in progress"
          complete          → check / "complete"
          deep backfill queued (recent window in or not) → hourglass-high
          queued, not started yet → hourglass-medium

        `blocked` is terminal and outranks `running`: the pair is never in
        flight once the bridge has recorded that it cannot read the channel.
      -->
      {#if entry.phase === "blocked"}
        <span
          class="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400"
          role="img"
          aria-label={entry.blockedReason
            ? `can't backfill: ${entry.blockedReason}`
            : "can't backfill: the bridge can't read this channel"}
          title={entry.blockedReason ?? "the bridge can't read this channel"}
        >
          <IconAlertCircle font-size={14} />
        </span>
      {:else if entry.running}
        <span
          class="flex items-center gap-1.5 text-xs text-base-500 dark:text-base-400"
          role="img"
          aria-label={entry.phase === "phase2"
            ? "deep backfill in progress"
            : "backfilling recent history"}
          title={entry.phase === "phase2"
            ? "deep backfill in progress"
            : "backfilling recent history"}
        >
          <LoadingSpinner size={12} />
        </span>
      {:else if entry.phase === "complete"}
        <span
          class="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"
          role="img"
          aria-label="complete"
          title="complete"
        >
          <IconCheck font-size={14} />
        </span>
      {:else if entry.phase === "phase2"}
        <span
          class="flex items-center gap-1.5 text-xs text-base-500 dark:text-base-400"
          role="img"
          aria-label="deep backfill queued"
          title="deep backfill queued"
        >
          <IconHourglassHigh font-size={14} />
        </span>
      {:else}
        <span
          class="flex items-center gap-1.5 text-xs text-base-500 dark:text-base-400"
          role="img"
          aria-label="queued"
          title="queued"
        >
          <IconHourglassMedium font-size={14} />
        </span>
      {/if}
    </span>
  </li>
{/snippet}

{#snippet proMembershipPanel()}
  {#if !proEnabled}
    <section
      class="rounded-lg border border-base-200 dark:border-base-800 px-4 py-3"
    >
      <p class="text-sm text-base-600 dark:text-base-400">
        Roomy Pro isn't enabled for your account yet, so the Discord Bridge
        can't be set up from here.
      </p>
    </section>
  {:else if statusQuery.isPending}
    <section
      class="rounded-lg border border-base-200 dark:border-base-800 px-4 py-3"
    >
      <p class="text-sm text-base-400">Checking your membership…</p>
    </section>
  {:else if statusQuery.isError}
    <section
      class="rounded-lg border border-red-500/30 bg-red-200/20 dark:bg-red-950/10 px-4 py-3"
    >
      <p class="text-sm text-base-600 dark:text-base-400">
        Couldn't load your Roomy Pro membership right now. Refresh to try
        again.
      </p>
    </section>
  {:else if !isProMember}
    <section
      class="rounded-lg border border-accent-500/30 bg-accent-200/20 dark:bg-accent-950/10 px-4 py-3"
    >
      <h2 class="text-sm font-semibold text-base-900 dark:text-base-100">
        Bridge bigger communities with Roomy Pro
      </h2>
      <p class="mt-1 text-sm text-base-600 dark:text-base-400">
        On the free tier this space bridges a Discord server of up to
        <strong>{FREE_BRIDGE_MEMBER_LIMIT} members</strong>. Roomy Pro raises
        that to <strong>1000 members</strong> and lets you use your membership
        here.
      </p>
      <div class="mt-3">
        <Button size="sm" variant="primary" href="/user/settings/subscription">
          Get Roomy Pro
        </Button>
      </div>
    </section>
  {:else}
    <section
      class="rounded-lg border border-base-200 dark:border-base-800 px-4 py-3"
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-base-900 dark:text-base-100">
            Roomy Pro membership
          </h2>
          <p class="mt-1 text-sm text-base-600 dark:text-base-400">
            Your plan bridges a Discord server of up to
            <strong>{status?.capacity ?? 0} members</strong>.
          </p>
        </div>
        {#if myGrant}
          <Badge variant={myGrant.spent ? "orange" : "green"}>
            {myGrant.spent ? "in use permanently" : "in use here"}
          </Badge>
        {:else}
          <Badge>not used here</Badge>
        {/if}
      </div>

      {#if myGrant?.spent}
        <p class="mt-3 text-sm text-base-600 dark:text-base-400">
          Your membership is permanently in use for this space. It can no
          longer be moved to another space. 
        </p>
      {:else if myGrant}
        <p class="mt-3 text-sm text-base-600 dark:text-base-400">
          This space is bridged using your Roomy Pro membership. You can free
          it to use on another space — unless this space's Discord server has
          grown beyond the free limit, which makes the membership permanent.
        </p>
        <div class="mt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={tokenBusy}
            onclick={onStopUsingMembership}
          >
            {tokenBusy ? "Freeing…" : "Stop using here"}
          </Button>
        </div>
      {:else}
        <p class="mt-3 text-sm text-base-600 dark:text-base-400">
          Use your Roomy Pro membership to bridge this space. Your membership allows you to bridge one Discord guild to one Roomy space, non-transferrable above the free limit of 50 Discord members.
        </p>
        <div class="mt-3">
          <Button
            size="sm"
            variant="primary"
            disabled={tokenBusy}
            onclick={onUseMembership}
          >
            {tokenBusy ? "Using…" : "Use membership here"}
          </Button>
        </div>
      {/if}
    </section>
  {/if}
{/snippet}

{#if bridgeStatus.type === "loaded" && bridgeStatus.guildId}
  <form class="pt-4">
    <div class="space-y-12">
      <p class="text-base/8">
        The Discord bridge is connected! This Roomy Space is bridged to your
        <a
          class="text-accent-500 underline underline-offset-3"
          href={`https://discord.com/channels/${bridgeStatus.guildId}`}
          target="_blank"
          rel="noreferrer"
        >
          Discord server
        </a>.
        You can disconnect it by going to Discord and running the slash command:
        <InlineMono>/disconnect-roomy-space</InlineMono>.
      </p>

      {@render proMembershipPanel()}

      {@render backfillStatusPanel()}
    </div>
  </form>
{:else}
  <form class="pt-4">
    <div class="space-y-12">

      {@render proMembershipPanel()}
      <div class="flex flex-col justify-center gap-8">
        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            <span class="pr-1">
              {bridgeStatus.type === "loaded" && hasAdminAccess ? "✅" : ""}
            </span>
            1. Grant bot admin access to your Roomy space
          </label>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            In order to bridge channels, threads, and messages the bridge must
            have admin access to your Roomy space.
          </p>

          <div class="mt-4">
            <Button
              disabled={bridgeStatus.type !== "loaded" || hasAdminAccess}
              onclick={grantBotPermissions}
            >
              Grant Access
            </Button>
            <Button
              disabled={bridgeStatus.type !== "loaded" || !hasAdminAccess}
              onclick={revokeBotPermissions}
            >
              Revoke Access
            </Button>
          </div>
        </div>

        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            <span class="pr-1">
              {bridgeStatus.type === "loaded" && bridgeStatus.guildId
                ? "✅"
                : ""}
            </span>
            2. Invite bot to your Discord server
          </label>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            You need to be a server admin to add the bot. Please allow all
            requested permissions. Click the button below and select your
            server.
          </p>

          <div class="mt-2">
            {#if bridgeStatus.type === "loaded"}
              <Button
                target="_blank"
                rel="noreferrer"
                href={`https://discord.com/oauth2/authorize?client_id=${bridgeStatus.appId}`}
              >
                Invite Bot
              </Button>
            {:else if bridgeStatus.type === "checking"}
              <Button disabled={true}>Loading...</Button>
            {:else if bridgeStatus.type === "error_checking"}
              <Button disabled={true}>Error connecting to bridge</Button>
            {/if}
          </div>
        </div>

        <div class="sm:col-span-4 flex flex-col">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            <span class="pr-1">
              {bridgeStatus.type === "loaded" && bridgeStatus.guildId
                ? "✅"
                : ""}
            </span>
            3. Connect your Roomy space to your Discord server
          </label>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Finish by running the
            <InlineMono>/connect-roomy-space</InlineMono> slash command in your
            Discord server to connect the space. It will require you to specify
            your space ID.
          </p>
          <div class="flex gap-2 items-center mt-4 ml-4">
            <strong>space-id:</strong>
            <InlineMono>{spaceId}</InlineMono>
            <Button size="icon" onclick={() => copyToClipboard(spaceId)}>
              <IconCopy />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </form>
{/if}
