<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import { page } from "$app/state";
  import { toast } from "@foxui/core";
  import Badge from "@roomy/design/components/ui/badge/Badge.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import InlineMono from "@roomy/design/components/helper/InlineMono.svelte";
  import { IconCopy } from "@roomy/design/icons";
  import { createMembersQuery } from "$lib/queries/members";
  import { sendEvents } from "$lib/mutations/send-events";
  import { newUlid, type UserDid, type Event } from "@roomy-space/sdk";
  import { setSpaceInfoExtra } from "$lib/components/layout/navbar.svelte";

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

  let bridgeStatus:
    | { type: "checking" }
    | {
        type: "loaded";
        guildId: undefined | string;
        appId: string;
      }
    | { type: "error_checking" } = $state({ type: "checking" });

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
    </div>
  </form>
{:else}
  <form class="pt-4">
    <div class="space-y-12">
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
