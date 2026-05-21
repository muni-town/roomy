<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import LoginScreen from "@roomy/design/components/user/LoginScreen.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import EarlyAlphaWarning from "@roomy/design/components/helper/EarlyAlphaWarning.svelte";
  import SpaceCard from "@roomy/design/components/spaces/SpaceCard.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconPlus } from "@roomy/design/icons";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import ThinSidebar from "$lib/components/sidebar/ThinSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { auth, login } from "$lib/auth.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { joinSpace, createSpace } from "$lib/mutations/space";
  import { goto } from "$app/navigation";
  import { queryClient } from "$lib/client";
  import { schemas, cache } from "@roomy-space/sdk";

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

  function friendlyAuthError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (/Failed to resolve OAuth server metadata/i.test(raw)) {
      return "Couldn't reach your PDS to start login. It may be rate-limiting this device (HTTP 429) or temporarily unavailable. Wait a few minutes, or check https://status.bsky.app, then try again.";
    }
    if (/\b429\b|Too Many Requests|RateLimit/i.test(raw)) {
      return "Your PDS is rate-limiting login attempts (HTTP 429). Wait a few minutes before trying again.";
    }
    return raw;
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
      error = friendlyAuthError(err);
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
      error = friendlyAuthError(e);
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

  let creating = $state(false);
  async function onCreateSpace() {
    const name = window.prompt("Space name:");
    if (!name || creating) return;
    creating = true;
    try {
      const { spaceId } = await createSpace({ name });
      goto(`/${spaceId}`);
    } catch (e) {
      console.error("Failed to create space", e);
    } finally {
      creating = false;
    }
  }

  let rejoining = $state<string | null>(null);

  async function rejoin(spaceId: string) {
    rejoining = spaceId;
    try {
      await joinSpace(spaceId);
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.space.getSpaces"),
      });
    } catch (e) {
      console.error("Failed to rejoin space", e);
    } finally {
      rejoining = null;
    }
  }

  $effect(() => {
    if (auth.authenticated) {
      setNavbar(homeNavbar);
      return () => setNavbar(undefined);
    }
  });
</script>

<div class="h-full overflow-y-auto bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  {#if auth.initError}
    <pre class="m-4 p-3 rounded-2xl text-sm whitespace-pre-wrap bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300">{friendlyAuthError(auth.initError)}</pre>
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
    <MainLayout>
      {#snippet serverBar()}
        <ThinSidebar />
      {/snippet}
      {@render homeContent()}
    </MainLayout>
  {/if}
</div>

{#snippet homeNavbar()}
  <div class="flex w-full items-center gap-3 px-2">
    <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
  </div>
{/snippet}

{#snippet homeContent()}
  {@const spacesQuery = createSpacesQuery()}

  <main class="h-full overflow-y-auto px-4">
    <div class="flex flex-col items-center justify-start py-8">
      <div class="flex flex-col gap-8 items-center w-full">
        <h1 class="text-5xl font-bold text-center text-base-950 dark:text-base-50">
          Hi Roomy 👋
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center text-pretty">
          A digital gardening platform for communities. Flourish in Spaces,
          curating knowledge and conversations together.
        </p>

        <EarlyAlphaWarning />

        <hr class="w-full max-w-2xl border-base-200 dark:border-base-800" />

        <Button class="gap-2" onclick={onCreateSpace} disabled={creating}>
          <IconPlus />
          {creating ? 'Creating…' : 'Create Space'}
        </Button>

        {#if spacesQuery.isPending}
          <p class="text-sm text-base-400">Loading spaces…</p>
        {:else if spacesQuery.isError}
          <p class="text-sm text-red-600">Error: {spacesQuery.error.message}</p>
        {:else if spacesQuery.data}
          {@const joined = spacesQuery.data.spaces.filter((s) => s.isMember)}
          {@const left = spacesQuery.data.spaces.filter((s) => !s.isMember)}

          {#if joined.length > 0}
            <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
              Your Spaces
            </h2>
            <section class="flex flex-row gap-8 mx-8 justify-center flex-wrap max-w-5xl">
              {#each joined as space (space.id)}
                {@render spaceCard(space)}
              {/each}
            </section>
          {:else}
            <p class="text-lg font-medium text-center">
              You haven't joined any spaces yet.
            </p>
          {/if}

          {#if left.length > 0}
            <hr class="w-full max-w-2xl border-base-200 dark:border-base-800" />
            <details class="w-full max-w-5xl px-8">
              <summary
                class="font-medium text-sm text-center opacity-70 cursor-pointer select-none hover:text-base-700 dark:hover:text-base-300 transition-colors"
              >
                Left Spaces ({left.length})
              </summary>
              <section class="flex flex-row gap-6 mt-4 justify-center flex-wrap">
                {#each left as space (space.id)}
                  <div
                    class="flex flex-col items-center gap-2 w-32 opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <SpaceAvatar
                      src={space.avatar ?? undefined}
                      id={space.id}
                      name={space.name ?? undefined}
                      size={64}
                    />
                    <span
                      class="text-sm font-medium text-center text-base-700 dark:text-base-300 line-clamp-2"
                    >
                      {space.name || "Unnamed Space"}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onclick={() => rejoin(space.id)}
                      disabled={rejoining === space.id}
                    >
                      {rejoining === space.id ? "Joining…" : "Rejoin"}
                    </Button>
                  </div>
                {/each}
              </section>
            </details>
          {/if}
        {/if}
      </div>
    </div>
  </main>
{/snippet}

{#snippet spaceCard(space: Space)}
  <SpaceCard
    name={space.name ?? undefined}
    description={space.description ?? undefined}
    href={`/${space.id}`}
  >
    {#snippet avatar()}
      <SpaceAvatar
        src={space.avatar ?? undefined}
        id={space.id}
        name={space.name ?? undefined}
        size={96}
      />
    {/snippet}
  </SpaceCard>
{/snippet}
