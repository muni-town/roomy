<!-- Clone of fox UI login form without being a modal: https://github.com/flo-bit/ui-kit/tree/main/packages/social/src/lib/components/bluesky-login -->
<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { backend } from "$lib/workers";

  import {
    Button,
    Subheading,
    Label,
    Input,
    Avatar,
    Box,
    Tabs,
    toast,
  } from "@fuxui/base";
  import { onMount } from "svelte";

  const tabs = ["Login", "Register"] as const;
  let tab = $state(tabs[0]) as (typeof tabs)[number];

  let handle = $state("");
  let error: string | null = $state(null);
  let loading = $state(false);

  let { ...props } = $props();

  async function login(evt: Event) {
    evt.preventDefault();

    if (loading) return;

    localStorage.setItem("redirect-after-login", window.location.href);

    loading = true;
    error = null;

    try {
      const redirect = await backend.login(handle);

      window.location.href = redirect;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  let input: HTMLInputElement | null = $state(null);

  let lastLogin: { handle: string; did: string; avatar: string } | undefined =
    $state(undefined);

  async function xrpcFetch<T>(
    xrpc: string,
    opts?: { query?: { [key: string]: string }; body?: any; admin?: boolean },
  ): Promise<T> {
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

  let password = $state("");
  let email = $state("");
  async function createAccountWithInviteCode() {
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
          handle: `${handle}${env.PUBLIC_PDS_HANDLE_SUFFIX}`,
          password,
        },
      });
      console.log("Created account", did);
      toast.success(`Created account, you may now login.`);
      tab = "Login";
      handle = `${handle}.pds.roomy.space`;
    } catch (e) {
      console.error(e);
      toast.error(`Error creating account: ${e}`);
    }
  }

  onMount(() => {
    lastLogin = JSON.parse(localStorage.getItem("last-login") || "null");
  });
</script>

<Box {...props}>
  <div class="flex justify-center mb-3">
    <Tabs
      items={tabs.map((x) => ({ name: x, onclick: () => (tab = x) }))}
      active={tab}
    />
  </div>

  {#if tab == "Login"}
    <form onsubmit={login} class="flex flex-col gap-2">
      <Subheading
        class="mb-1 inline-flex items-center gap-2 text-xl font-bold text-center"
      >
        <svg
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="-40 -40 680 620"
          version="1.1"
          class={["text-accent-600 dark:text-accent-400 size-6"]}
          aria-hidden="true"
        >
          <path
            d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z"
          />
        </svg>
        Login with your Bluesky / ATProto account</Subheading
      >

      {#if lastLogin?.handle}
        <Label for="bluesky-handle" class="mt-4 text-sm">Recent login:</Label>
        <Button
          class="max-w-xs overflow-x-hidden justify-start truncate"
          variant="primary"
          onclick={(evt) => {
            handle = lastLogin?.handle ?? "";
            login(evt);
          }}
          disabled={loading}
        >
          <Avatar src={lastLogin.avatar} class="size-6" />

          <div
            class="text-accent-600 dark:text-accent-400 text-md max-w-full truncate overflow-x-hidden font-semibold"
          >
            <p>{loading ? "Loading..." : lastLogin.handle}</p>
          </div>
        </Button>
      {/if}

      <div class="mt-4 w-full">
        <Label for="bluesky-handle" class="text-sm">Your handle</Label>
        <div class="mt-2">
          <Input
            bind:ref={input}
            type="text"
            name="bluesky-handle"
            id="bluesky-handle"
            placeholder="yourname.bsky.social"
            class="w-full"
            bind:value={handle}
          />
        </div>
      </div>

      {#if error}
        <p class="text-accent-500 mt-2 text-sm font-medium">{error}</p>
      {/if}

      <Button
        type="submit"
        class="mt-2 ml-auto w-full md:w-auto"
        disabled={loading}>{loading ? "Loading..." : "Login"}</Button
      >
    </form>
  {:else if tab == "Register"}
    <Subheading
      class="mb-3 inline-flex items-center gap-2 text-xl font-bold text-center"
    >
      Register for an Experimental Roomy Account
    </Subheading>
    <form
      class="flex flex-col gap-2 w-[20em]"
      onsubmit={createAccountWithInviteCode}
    >
      <div class="flex items-center">
        <Input
          class="shrink grow min-w-0"
          type="username"
          bind:value={handle}
          placeholder="Handle"
        />
        {env.PUBLIC_PDS_HANDLE_SUFFIX}
      </div>
      <Input type="password" bind:value={password} placeholder="Password" />
      <Input type="email" bind:value={email} placeholder="Email" />
      <Button type="submit" class="mt-3">Register Account</Button>
    </form>
  {/if}
</Box>
