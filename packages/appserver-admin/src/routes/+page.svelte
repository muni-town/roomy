<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import {
    login as authLogin,
    logout as authLogout,
    auth,
  } from "$lib/auth.svelte";
  import {
    callAdminGetDashboardStats,
    callAdminListSpaces,
    type DashboardStats,
    type AdminSpaceStats,
  } from "$lib/xrpc";
  import { untrack } from "svelte";
  import {
    IconDatabase,
    IconHome,
    IconSettings,
    IconBell,
    IconAlertCircle,
    IconLoading,
    IconLogOut,
    IconSquaresPlus,
    IconHashtag,
  } from "@roomy/design/icons";

  let handle = $state("");

  async function handleLogin() {
    if (!handle.trim()) return;
    await authLogin(handle.trim());
  }

  async function handleLogout() {
    await authLogout();
  }

  // ── Dashboard data ──────────────────────────────────────────────────────

  let stats = $state<DashboardStats | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function fetchStats() {
    if (!auth.agent) return;
    loading = true;
    error = null;
    try {
      stats = await callAdminGetDashboardStats(auth.agent);
    } catch (err: any) {
      error = err?.message ?? String(err);
      stats = null;
    } finally {
      loading = false;
    }
  }

  // ── Per-space list (paginated, sorted by member count) ───────────────

  let spaces = $state<AdminSpaceStats[]>([]);
  let spacesCursor = $state<string | undefined>(undefined);
  let spacesLoading = $state(false);
  let spacesError = $state<string | null>(null);
  let spacesHasMore = $state(false);

  async function fetchSpaces(reset = false) {
    if (!auth.agent) return;
    if (spacesLoading) return;
    if (reset) {
      spacesCursor = undefined;
      spaces = [];
    } else if (!spacesHasMore) {
      return;
    }
    spacesLoading = true;
    spacesError = null;
    try {
      const res = await callAdminListSpaces(auth.agent, {
        limit: 50,
        cursor: spacesCursor,
      });
      spaces = reset ? res.spaces : [...spaces, ...res.spaces];
      spacesCursor = res.cursor;
      spacesHasMore = res.cursor !== undefined;
    } catch (err: any) {
      spacesError = err?.message ?? String(err);
    } finally {
      spacesLoading = false;
    }
  }

  let interval: ReturnType<typeof setInterval> | undefined;
  // Fetch on mount and every 30s.
  $effect(() => {
    if (auth.authenticated && auth.agent) {
      // untrack: fetchStats/fetchSpaces read+write $state (loading, etc).
      // Without untrack, those reads register as effect deps, the writes
      // invalidate the effect, and it re-runs in a tight loop — issuing a
      // fresh listSpaces HTTP call each cycle and exhausting the shared
      // per-IP rate-limit budget (which then 429s getDashboardStats too).
      untrack(() => {
        fetchStats();
        fetchSpaces(true);
      });
      interval = setInterval(() => untrack(fetchStats), 30_000);
      return () => clearInterval(interval);
    }
  });

  // ── Formatting helpers ───────────────────────────────────────────────────

  function fmtCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  }

  function fmtUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(" ");
  }

  function fmtBytes(bytes: number): string {
    if (bytes === 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
    if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
    return `${bytes} B`;
  }

  // ── Activity stat card config ───────────────────────────────────────────

  const activityCards = [
    {
      label: "Active Spaces",
      get value() { return stats ? fmtCount(stats.activity.activeSpaces) : "—"; },
      icon: IconHome,
      bgClass: "bg-accent-100 dark:bg-accent-900/30",
      iconClass: "text-accent-600 dark:text-accent-400",
    },
    {
      label: "Total Events",
      get value() { return stats ? fmtCount(stats.activity.totalEvents) : "—"; },
      icon: IconHashtag,
      bgClass: "bg-blue-100 dark:bg-blue-900/30",
      iconClass: "text-blue-600 dark:text-blue-400",
    },
    {
      label: "Events Today",
      get value() { return stats ? fmtCount(stats.activity.eventsToday) : "—"; },
      icon: IconDatabase,
      bgClass: "bg-emerald-100 dark:bg-emerald-900/30",
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Connected Users",
      get value() { return stats ? fmtCount(stats.activity.connectedUsers) : "—"; },
      icon: IconBell,
      bgClass: "bg-amber-100 dark:bg-amber-900/30",
      iconClass: "text-amber-600 dark:text-amber-400",
    },
  ];

  const systemCards = [
    {
      label: "Uptime",
      get value() { return stats ? fmtUptime(stats.system.uptime) : "—"; },
      sub: "Since last appserver start",
    },
    {
      label: "Appserver DID",
      get value() { return stats?.system.appserverDid ?? "—"; },
      sub: "Configured in env",
    },
    {
      label: "Database",
      get value() { return stats ? fmtBytes(stats.system.dbSizeBytes) : "—"; },
      get sub() { return stats?.system.dbSizeBytes ? "SQLite file on disk" : "Size unknown"; },
    },
    {
      label: "Push Notifications",
      get value() {
        if (!stats) return "—";
        return stats.system.pushVapidConfigured ? "Active" : "Not configured";
      },
      sub() {
        if (!stats) return "VAPID status unknown";
        return `${stats.system.pushTotalSubscriptions} subscription(s)`;
      },
    },
  ];
</script>

<div class="min-h-screen bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  {#if auth.initError}
    <div class="flex items-center justify-center min-h-screen">
      <div class="max-w-md text-center">
        <IconAlertCircle class="size-12 mx-auto mb-4 text-red-500" />
        <h1 class="text-xl font-bold mb-2">Initialization Error</h1>
        <pre class="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-4 rounded-2xl whitespace-pre-wrap">{auth.initError}</pre>
      </div>
    </div>
  {:else if auth.authError}
    <div class="flex items-center justify-center min-h-screen">
      <div class="max-w-md text-center">
        <IconAlertCircle class="size-12 mx-auto mb-4 text-red-500" />
        <h1 class="text-2xl font-bold mb-2">Access Denied</h1>
        <p class="text-red-600 dark:text-red-400 mb-4">{auth.authError}</p>
        <p class="text-sm text-base-500 mb-6">Only DIDs on the admin allowlist can access this dashboard.</p>
        <Button onclick={handleLogout}>Sign out</Button>
      </div>
    </div>
  {:else if !auth.authenticated}
    <div class="flex items-center justify-center min-h-screen">
      <div class="max-w-md w-full px-6">
        <!-- Brand -->
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center size-14 rounded-2xl bg-accent-100 dark:bg-accent-900/30 mb-4">
            <IconSquaresPlus class="size-7 text-accent-600 dark:text-accent-400" />
          </div>
          <h1 class="text-2xl font-bold tracking-tight">Appserver Admin</h1>
          <p class="text-base-500 dark:text-base-400 mt-1">Sign in to manage your appserver</p>
        </div>

        <!-- Access notice -->
        <div class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 text-sm mb-6">
          <p class="font-medium mb-1">Access control</p>
          <p class="text-base-600 dark:text-base-400">
            Only DIDs listed in <code class="bg-base-200/50 dark:bg-base-800/50 px-1 rounded text-xs">PUBLIC_APPSERVER_ADMIN_DIDS</code> can access this dashboard.
          </p>
        </div>

        <!-- Login form -->
        <div>
          <label for="handle" class="block mb-1.5 font-medium text-sm">ATProto handle</label>
          <input
            id="handle"
            type="text"
            placeholder="user.bsky.social"
            bind:value={handle}
            class="w-full px-4 py-2.5 rounded-xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 text-base-800 dark:text-base-200 placeholder:text-base-400 focus:outline-none focus:ring-2 focus:ring-accent-400/50 focus:border-accent-400 text-sm"
            onkeydown={(e) => e.key === "Enter" && handleLogin()}
          />
          <Button class="mt-3 w-full" onclick={handleLogin} disabled={!handle.trim()}>
            Sign in with AT Protocol
          </Button>
        </div>
      </div>
    </div>
  {:else}
    <!-- ── Top navigation bar ─────────────────────────────────────────────── -->
    <header class="sticky top-0 z-10 border-b border-base-200 dark:border-base-800 bg-white/80 dark:bg-base-950/80 backdrop-blur-lg">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex items-center justify-between h-16">
          <!-- Left: brand + nav -->
          <div class="flex items-center gap-6">
            <div class="flex items-center gap-2">
              <div class="flex items-center justify-center size-8 rounded-lg bg-accent-100 dark:bg-accent-900/30">
                <IconSquaresPlus class="size-4 text-accent-600 dark:text-accent-400" />
              </div>
              <span class="font-semibold text-sm">Appserver Admin</span>
            </div>
            <nav class="hidden sm:flex items-center gap-1">
              <a href="/" class="px-3 py-1.5 rounded-lg text-sm font-medium bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300">
                Dashboard
              </a>
              <a href="/playground" class="px-3 py-1.5 rounded-lg text-sm font-medium text-base-500 dark:text-base-400 hover:text-base-700 dark:hover:text-base-200 hover:bg-base-100 dark:hover:bg-base-900/50 transition-colors">
                XRPC Playground
              </a>
            </nav>
          </div>

          <!-- Right: user + logout -->
          <div class="flex items-center gap-3">
            {#if loading}
              <IconLoading class="size-4 animate-spin text-base-400" />
            {/if}
            <span class="text-xs text-base-400 hidden sm:block font-mono truncate max-w-[200px]" title={auth.session?.did}>
              {auth.session?.did}
            </span>
            <Button variant="ghost" size="sm" onclick={handleLogout}>
              <IconLogOut class="size-4" />
              <span class="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </div>
      </div>
    </header>

    <!-- ── Main content ──────────────────────────────────────────────────── -->
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Page heading -->
      <div class="mb-8">
        <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p class="text-base-500 dark:text-base-400 mt-1 text-sm">
          Overview of your appserver's health and activity
        </p>
      </div>

      {#if error}
        <div class="mb-8 rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          <p class="font-medium mb-1">Failed to load dashboard stats</p>
          <p class="text-red-600 dark:text-red-400">{error}</p>
          <Button class="mt-2" variant="secondary" onclick={fetchStats}>Retry</Button>
        </div>
      {/if}

      <!-- ── Activity stats ──────────────────────────────────────────────── -->
      <section class="mb-10">
        <h2 class="text-sm font-semibold text-base-500 dark:text-base-400 uppercase tracking-wider mb-4">Activity</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {#each activityCards as card}
            <div class="relative overflow-hidden rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5 transition-shadow hover:shadow-md">
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center justify-center size-10 rounded-xl {card.bgClass}">
                  <card.icon class="size-5 {card.iconClass}" />
                </div>
              </div>
              <p class="text-2xl font-bold tracking-tight">{card.value}</p>
              <p class="text-xs text-base-500 dark:text-base-400 mt-1">{card.label}</p>
            </div>
          {/each}
        </div>
      </section>

      <!-- ── System health ───────────────────────────────────────────────── -->
      <section class="mb-10">
        <h2 class="text-sm font-semibold text-base-500 dark:text-base-400 uppercase tracking-wider mb-4">System</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {#each systemCards as card}
            <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5">
              <p class="text-lg font-bold tracking-tight">{card.value}</p>
              <p class="text-xs text-base-500 dark:text-base-400 mt-0.5">{card.label}</p>
              <p class="text-xs text-base-400 dark:text-base-500 mt-1">{typeof card.sub === "function" ? card.sub() : card.sub}</p>
            </div>
          {/each}
        </div>
      </section>

      <!-- ── Per-space stats ─────────────────────────────────────────────── -->
      <section class="mb-10">
        <h2 class="text-sm font-semibold text-base-500 dark:text-base-400 uppercase tracking-wider mb-4">Spaces</h2>

        {#if spacesError}
          <div class="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
            {spacesError}
          </div>
        {:else if spaces.length === 0 && !spacesLoading}
          <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-12">
            <div class="flex flex-col items-center justify-center text-base-400 dark:text-base-500">
              <IconHome class="size-8 mb-3" />
              <p class="text-sm">No spaces materialized yet</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3">
            {#each spaces as space (space.did)}
              <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5">
                <!-- Space header -->
                <div class="flex items-center justify-between mb-3">
                  <div class="min-w-0">
                    <p class="font-semibold text-sm truncate">{space.name}</p>
                    <p class="text-xs text-base-400 font-mono truncate" title={space.did}>{space.did}</p>
                  </div>
                  <div class="flex items-center gap-4 text-xs text-base-500 shrink-0">
                    <span title="Members" class="font-medium text-base-700 dark:text-base-300">{fmtCount(space.memberCount)} members</span>
                    <span title="Total events">{fmtCount(space.totalEvents)} total</span>
                    <span title="Events today" class="text-emerald-600 dark:text-emerald-400">{fmtCount(space.eventsToday)} today</span>
                  </div>
                </div>

                <!-- Event type breakdown bar -->
                {#if Object.keys(space.eventBreakdown).length > 0}
                  {@const total = Object.values(space.eventBreakdown).reduce((a, b) => a + b, 0)}
                  {#if total > 0}
                    <div class="flex h-2 rounded-full overflow-hidden bg-base-100 dark:bg-base-800">
                      {#each Object.entries(space.eventBreakdown) as [type, count]}
                        <div
                          class="h-full transition-all"
                          style="width: {(count / total) * 100}%"
                          title="{type}: {count.toLocaleString()} ({((count / total) * 100).toFixed(1)}%)"
                          class:bg-accent-400={type === "space.roomy.message.createMessage.v0"}
                          class:bg-blue-400={type === "space.roomy.reaction.addReaction.v0" || type === "space.roomy.reaction.removeReaction.v0"}
                          class:bg-emerald-400={type === "space.roomy.space.joinSpace.v0"}
                          class:bg-amber-400={type === "space.roomy.space.leaveSpace.v0"}
                          class:bg-pink-400={type !== "space.roomy.message.createMessage.v0" && type !== "space.roomy.reaction.addReaction.v0" && type !== "space.roomy.reaction.removeReaction.v0" && type !== "space.roomy.space.joinSpace.v0" && type !== "space.roomy.space.leaveSpace.v0"}
                        ></div>
                      {/each}
                    </div>
                    <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-base-400">
                      {#each Object.entries(space.eventBreakdown) as [type, count]}
                        <span class="flex items-center gap-1">
                          <span class="size-2 rounded-full inline-block"
                            class:bg-accent-400={type === "space.roomy.message.createMessage.v0"}
                            class:bg-blue-400={type === "space.roomy.reaction.addReaction.v0" || type === "space.roomy.reaction.removeReaction.v0"}
                            class:bg-emerald-400={type === "space.roomy.space.joinSpace.v0"}
                            class:bg-amber-400={type === "space.roomy.space.leaveSpace.v0"}
                            class:bg-pink-400={type !== "space.roomy.message.createMessage.v0" && type !== "space.roomy.reaction.addReaction.v0" && type !== "space.roomy.reaction.removeReaction.v0" && type !== "space.roomy.space.joinSpace.v0" && type !== "space.roomy.space.leaveSpace.v0"}
                          ></span>
                          {type.replace(/^space\.roomy\./, "").replace(/\.v0$/, "")}: {count.toLocaleString()}
                        </span>
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>

          <!-- Load more -->
          {#if spacesHasMore}
            <div class="flex justify-center mt-4">
              <Button onclick={() => fetchSpaces(false)} disabled={spacesLoading}>
                {#if spacesLoading}
                  <IconLoading class="size-4 animate-spin" />
                  Loading…
                {:else}
                  Load more
                {/if}
              </Button>
            </div>
          {:else if spaces.length > 0}
            <p class="text-center text-xs text-base-400 mt-4">End of list</p>
          {/if}
        {/if}
      </section>

      <!-- ── Placeholder sections ────────────────────────────────────────── -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        <!-- Recent activity removed; feed will be added later. -->

        <!-- Alerts & warnings -->
        <!--
        <section class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-6">
          <h2 class="text-sm font-semibold text-base-500 dark:text-base-400 uppercase tracking-wider mb-4">Alerts</h2>
          <div class="flex flex-col items-center justify-center py-12 text-base-400 dark:text-base-500">
            <IconAlertCircle class="size-8 mb-3" />
            <p class="text-sm">No alerts configured yet</p>
          </div>
        </section>
        -->

      </div>

      <!-- ── Quick actions ───────────────────────────────────────────────── -->
      <section class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-6">
        <h2 class="text-sm font-semibold text-base-500 dark:text-base-400 uppercase tracking-wider mb-4">Quick Actions</h2>
        <div class="flex flex-wrap gap-3">
          <a href="/playground">
            <Button variant="secondary">
              <IconSettings class="size-4" />
              XRPC Playground
            </Button>
          </a>
        </div>
      </section>
    </main>
  {/if}
</div>
