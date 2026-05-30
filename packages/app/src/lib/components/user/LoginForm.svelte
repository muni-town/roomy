<!--
  Thin wrapper around the presentational LoginScreen.
  Owns all auth wiring (peer login, app-password register) and passes
  state/callbacks down to the design package's LoginScreen shell.
-->
<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { peer } from "$lib/workers";

  import { toast } from "@foxui/core";
  import { Handle } from "@roomy-space/sdk";
  import { onMount } from "svelte";
  import LoginScreen from "@roomy/design/components/user/LoginScreen.svelte";

  let tab = $state<"Login" | "Register">("Login");

  let _handle = $state("");
  // Mirror previous normalization (trim, strip @, lowercase) on set.
  function setHandle(v: string) {
    _handle = v.trim().replace("@", "").toLowerCase();
  }

  let error: string | null = $state(null);
  let loading = $state(false);
  let password = $state("");
  let email = $state("");

  let { ...props } = $props();

  async function login(evt: Event) {
    evt.preventDefault();
    if (loading) return;

    localStorage.setItem("redirect-after-login", window.location.href);

    loading = true;
    error = null;

    try {
      const redirect = await peer.login(Handle.assert(_handle));

      console.log("redirect", redirect);
      window.location.href = redirect;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function xrpcFetch<T>(
    xrpc: string,
    opts?: { query?: { [key: string]: string }; body?: any; admin?: boolean },
  ): Promise<T> {
    if (!env.PUBLIC_PDS) throw new Error("No public PDS defined");

    const url = new URL(env.PUBLIC_PDS);
    url.pathname = `/xrpc/${xrpc}`;
    if (opts?.query) {
      for (const [key, value] of Object.values(opts.query)) {
        if (key && value) url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url, {
      headers: [["content-type", "application/json"]],
      method: opts?.body ? "post" : "get",
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!resp.ok) throw await resp.text();

    return await resp.json();
  }

  async function createAccountWithInviteCode(evt: Event) {
    evt.preventDefault();
    try {
      const { did } = await xrpcFetch<{
        accessJwt: string;
        refreshJwt: string;
        handle: string;
        did: string;
        didDoc?: unknown;
      }>(`com.atproto.server.createAccount`, {
        body: {
          email,
          inviteCode: env.PUBLIC_PDS_INVITE_CODE,
          handle: `${_handle}${env.PUBLIC_PDS_HANDLE_SUFFIX}`,
          password,
        },
      });
      console.log("Created account", did);
      toast.success(`Created account, you may now login.`);
      tab = "Login";
      setHandle(`${_handle}${env.PUBLIC_PDS_HANDLE_SUFFIX}`);
    } catch (e) {
      console.error(e);
      toast.error(`Error creating account: ${e}`);
    }
  }

  let lastLogin: { handle: string; did: string; avatar: string } | undefined =
    $state(undefined);

  onMount(() => {
    lastLogin = JSON.parse(localStorage.getItem("last-login") || "null");
  });

  function onLastLoginClick(evt: Event) {
    setHandle(lastLogin?.handle ?? "");
    login(evt);
  }
</script>

<LoginScreen
  {...props}
  bind:handle={() => _handle, (v: string) => setHandle(v)}
  bind:email
  bind:password
  bind:tab
  {loading}
  {error}
  {lastLogin}
  handleSuffix={env.PUBLIC_PDS_HANDLE_SUFFIX ?? ""}
  onLogin={login}
  onRegister={createAccountWithInviteCode}
  {onLastLoginClick}
/>
