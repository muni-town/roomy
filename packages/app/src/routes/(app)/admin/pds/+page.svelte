<script lang="ts">
  import type { InviteCode } from "@atproto/api/dist/client/types/com/atproto/server/defs";
  import type { Repo } from "@atproto/api/dist/client/types/com/atproto/sync/listRepos";
  import { Tabs, toast } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import Input from "$lib/components/ui/input/Input.svelte";

  const tabs = ["Users", "Invite Codes"] as const;
  let tab = $state("Users") as (typeof tabs)[number];

  let pds = $state(localStorage.getItem("admin-pds") || "");
  let adminPassword = $state("");
  $effect(() => {
    localStorage.setItem("admin-pds", pds);
  });

  async function xrpcFetch<T>(
    xrpc: string,
    opts?: { query?: { [key: string]: string }; body?: any; admin?: boolean },
  ): Promise<T> {
    const url = new URL(`https://${pds}`);
    url.pathname = `/xrpc/${xrpc}`;
    if (opts?.query) {
      for (const [key, value] of Object.values(opts.query)) {
        if (key && value) url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url, {
      headers: [
        ...((opts?.admin
          ? [["Authorization", `Basic ${btoa(`admin:${adminPassword}`)}`]]
          : []) as [string, string][]),
        ["content-type", "application/json"],
      ],
      method: opts?.body ? "post" : "get",
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!resp.ok) throw await resp.text();

    return await resp.json();
  }

  let accounts = $state.raw([]) as Repo[];
  async function getAccounts() {
    accounts = (
      await xrpcFetch<{ repos: Repo[] }>(`com.atproto.sync.listRepos`, {
        admin: true,
      })
    ).repos;
  }

  let inviteCodes = $state.raw([]) as InviteCode[];
  async function getInviteCodes() {
    try {
      inviteCodes = (
        await xrpcFetch<{ codes: InviteCode[] }>(
          `com.atproto.admin.getInviteCodes`,
          { admin: true },
        )
      ).codes;
    } catch (e) {
      console.error(e);
      toast.error("Error fetching invite codes");
    }
  }

  async function create1MillionUseInviteCode() {
    try {
      const { code } = await xrpcFetch<{ code: string }>(
        `com.atproto.server.createInviteCode`,
        {
          admin: true,
          body: { useCount: 1000000 },
        },
      );
      console.log("code", code);
      toast.success(`Created invite code: ${code}.`);
    } catch (e) {
      console.error(e);
      toast.error(`Error creating invite code`);
    }
  }

  let handle = $state("");
  let password = $state("");
  let inviteCode = $state("");
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
        body: { email, inviteCode, handle, password },
      });
      console.log("Created account", did);
      toast.success(`Created account: ${did}.`);
    } catch (e) {
      console.error(e);
      toast.error(`Error creating invite code: ${e}`);
    }
  }
</script>

<h1 class="text-xl font-bold m-0">PDS Administration</h1>

<p>This interface is specifically for if you are the admin of your PDS.</p>

<Input bind:value={pds} placeholder="PDS" />
<Input
  type="password"
  bind:value={adminPassword}
  placeholder="Admin password"
/>

<Tabs
  items={tabs.map((x) => ({ name: x, onclick: () => (tab = x) }))}
  active={tab}
/>

{#if tab == "Users"}
  <form
    class="flex flex-col gap-2 w-[20em]"
    onsubmit={createAccountWithInviteCode}
  >
    <Input type="username" bind:value={handle} placeholder="Handle" />
    <Input type="password" bind:value={password} placeholder="Password" />
    <Input bind:value={inviteCode} placeholder="Invite Code" />
    <Input type="email" bind:value={email} placeholder="Email" />
    <Button type="submit">Register Account</Button>
  </form>
  <div>
    <Button onclick={() => getAccounts()}>Fetch Account List</Button>
  </div>
  <ul class="list-disc ml-8">
    {#each accounts as repo}
      <li>
        <a
          href={`https://pdsls.dev/at/${repo.did}`}
          target="_blank"
          class="text-accent-500"
          class:line-through={!repo.active}>{repo.did}</a
        >
        {#if repo.status}
          ( {repo.status} )
        {/if}
      </li>
    {/each}
  </ul>
{:else if tab == "Invite Codes"}
  <div>
    <Button onclick={() => getInviteCodes()}>Fetch Invite Codes</Button>
    <Button onclick={() => create1MillionUseInviteCode()}
      >Create 1 Million Use Invite Code</Button
    >
  </div>

  <ul class="list-disc ml-8">
    {#each inviteCodes as code}
      <li>
        <span class="text-accent-500" class:line-through={code.disabled}
          >{code.code}</span
        >
        for {code.forAccount} with {code.uses.length} uses and {code.available} available.
      </li>
    {/each}
  </ul>
{/if}
