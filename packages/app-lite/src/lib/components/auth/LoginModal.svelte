<!--
  Full-screen login modal extracted from the home page.
  Pure presentation + auth wiring — no route-specific logic.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import LoginScreen from "@roomy/design/components/user/LoginScreen.svelte";
  import { login } from "$lib/auth.svelte";

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
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-base-50/90 dark:bg-base-950/90 backdrop-blur-sm"
>
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
