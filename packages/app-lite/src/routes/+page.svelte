<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import LoginScreen from "@roomy/design/components/user/LoginScreen.svelte";
  import { auth, login, logout } from "$lib/auth.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { schemas } from "@roomy-space/sdk";

  type Space = typeof schemas.queries.getSpaces.Space.infer;

  let handle = $state("");
  let email = $state("");
  let password = $state("");
  let tab = $state<"Login" | "Register">("Login");
  let loading = $state(false);
  let error = $state<string | null>(null);

  function setHandle(v: string) {
    handle = v.trim().replace("@", "").toLowerCase();
  }

  async function onLogin(evt: Event) {
    evt.preventDefault();
    const h = handle.trim();
    if (!h || loading) return;
    loading = true;
    error = null;
    try {
      localStorage.setItem("just-logged-in", "1");
      await login(h);
    } catch (err) {
      localStorage.removeItem("just-logged-in");
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function xrpcFetch<T>(
    xrpc: string,
    opts?: { query?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    if (!env.PUBLIC_PDS) throw new Error("No public PDS defined");
    const url = new URL(env.PUBLIC_PDS);
    url.pathname = `/xrpc/${xrpc}`;
    if (opts?.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (key && value) url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url, {
      headers: [["content-type", "application/json"]],
      method: opts?.body ? "post" : "get",
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!resp.ok) throw new Error(await resp.text());
    return await resp.json();
  }

  async function onRegister(evt: Event) {
    evt.preventDefault();
    if (loading) return;
    loading = true;
    error = null;
    try {
      const suffix = env.PUBLIC_PDS_HANDLE_SUFFIX ?? "";
      const fullHandle = `${handle}${suffix}`;
      await xrpcFetch<{
        accessJwt: string;
        refreshJwt: string;
        handle: string;
        did: string;
      }>("com.atproto.server.createAccount", {
        body: {
          email,
          inviteCode: env.PUBLIC_PDS_INVITE_CODE,
          handle: fullHandle,
          password,
        },
      });
      tab = "Login";
      setHandle(fullHandle);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  type LastLogin = { handle: string; did: string; avatar: string };
  let lastLogin = $state<LastLogin | undefined>(undefined);

  onMount(() => {
    const raw = localStorage.getItem("last-login");
    lastLogin = raw ? JSON.parse(raw) : undefined;
  });

  function onLastLoginClick(evt: Event) {
    setHandle(lastLogin?.handle ?? "");
    onLogin(evt);
  }
</script>

<div class="min-h-screen bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  {#if auth.initError}
    <pre class="m-4 p-3 rounded-2xl text-sm whitespace-pre-wrap bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300">{auth.initError}</pre>
  {:else if !auth.authenticated}
    <div class="flex items-center justify-center min-h-screen px-4">
      <LoginScreen
        class="w-full max-w-sm"
        bind:handle={() => handle, (v: string) => setHandle(v)}
        bind:email
        bind:password
        bind:tab
        {loading}
        {error}
        {lastLogin}
        handleSuffix={env.PUBLIC_PDS_HANDLE_SUFFIX ?? ""}
        onLogin={onLogin}
        onRegister={onRegister}
        {onLastLoginClick}
      />
    </div>
  {:else}
    {@render spaceList()}
  {/if}
</div>

{#snippet spaceList()}
  {@const spacesQuery = createSpacesQuery()}

  <header class="flex items-center justify-between px-4 py-2 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
    <div class="flex items-center gap-3">
      <span class="font-bold text-lg">Roomy</span>
      <span class="text-sm text-base-500 dark:text-base-400">{auth.agent?.did}</span>
    </div>
    <Button variant="ghost" size="sm" onclick={logout}>Logout</Button>
  </header>

  <main class="max-w-2xl mx-auto px-4 py-6">
    <h2 class="text-lg font-semibold mb-3">Your spaces</h2>

    {#if spacesQuery.isPending}
      <p class="text-sm text-base-400">Loading spaces…</p>
    {:else if spacesQuery.isError}
      <p class="text-sm text-red-600">Error: {spacesQuery.error.message}</p>
    {:else if spacesQuery.data}
      {@const spaces = spacesQuery.data.spaces}
      {#if spaces.length === 0}
        <p class="text-sm text-base-400">No spaces found.</p>
      {:else}
        <ul class="space-y-2">
          {#each spaces as space (space.id)}
            {@render spaceItem(space)}
          {/each}
        </ul>
      {/if}
    {/if}
  </main>
{/snippet}

{#snippet spaceItem(space: Space)}
  <li>
    <a
      href={`/${space.id}`}
      class="block p-3 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 hover:border-base-300 dark:hover:border-base-700"
    >
    <div class="flex items-center justify-between">
      <span class="font-medium text-sm truncate">{space.name || space.id.slice(0, 12) + "…"}</span>
      {#if space.unreadCount > 0}
        <span class="bg-accent-500 text-white text-xs px-1.5 py-0.5 rounded-full font-medium min-w-[20px] text-center">
          {space.unreadCount}
        </span>
      {/if}
    </div>
    <div class="flex gap-1 mt-1">
      {#if space.isMember}
        <span class="text-[10px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">member</span>
      {/if}
      {#if space.isAdmin}
        <span class="text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">admin</span>
      {/if}
    </div>
    </a>
  </li>
{/snippet}
