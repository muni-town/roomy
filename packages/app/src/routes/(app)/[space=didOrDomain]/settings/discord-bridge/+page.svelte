<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { toast } from "@foxui/core";
  import Badge from "$lib/components/ui/badge/Badge.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { onMount } from "svelte";
  import InlineMono from "$lib/components/helper/InlineMono.svelte";
  import { IconCopy } from "@roomy/design/icons";
  import { getAppState } from "$lib/queries";
  import { peer } from "$lib/workers";
  import { newUlid, type Event } from "@roomy-space/sdk";
  const app = getAppState();

  const space = $derived(app.joinedSpace?.id);

  // Discord bridge bot DID that needs admin access
  const BRIDGE_BOT_DID = "did:plc:vjztjtisourrydgksg44u7fe";

  let bridgeStatus:
    | { type: "checking" }
    | {
        type: "loaded";
        guildId: undefined | string;
        appId: string;
        hasFullWritePermissions: boolean;
      }
    | { type: "error_checking" } = $state({
    type: "checking",
  });

  async function updateBridgeStatus() {
    if (!space) return;
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
        `${env.PUBLIC_DISCORD_BRIDGE}/get-guild-id?spaceId=${space}`,
      );
      // 404 means no guild is connected yet - that's expected for unconnected spaces
      let guildId: string | undefined;
      if (gResp.ok) {
        const data: { guildId?: string } = await gResp.json();
        guildId = data.guildId;
      }

      // Check if the bridge bot has admin permissions
      const currentSpaceState = app.currentSpaceState;
      const hasAdminAccess = currentSpaceState?.permissions.some(
        ([did, permission]) => did === BRIDGE_BOT_DID && permission === "admin",
      ) ?? false;

      bridgeStatus = {
        type: "loaded",
        appId: info.discordAppId,
        guildId,
        hasFullWritePermissions: hasAdminAccess,
      };
    } catch (e) {
      bridgeStatus = {
        type: "error_checking",
      };
    }
  }

  async function grantBotPermissions() {
    if (!space) {
      toast.error("No space selected");
      return;
    }

    try {
      // Send addAdmin event to make the bridge bot an admin
      const event: Event = {
        id: newUlid(),
        $type: "space.roomy.space.addAdmin.v0",
        userDid: BRIDGE_BOT_DID,
      };

      await peer.sendEvent(space, event);

      // Update status to reflect the change
      bridgeStatus =
        bridgeStatus.type === "loaded"
          ? { ...bridgeStatus, hasFullWritePermissions: true }
          : bridgeStatus;

      toast.success("Successfully granted bot permissions.");
    } catch (error) {
      console.error("Failed to grant bot permissions:", error);
      toast.error("Failed to grant bot permissions. Please try again.");
    }
  }

  async function revokeBotPermissions() {
    if (!space) {
      toast.error("No space selected");
      return;
    }

    try {
      // Send removeAdmin event to revoke bridge bot admin access
      const event: Event = {
        id: newUlid(),
        $type: "space.roomy.space.removeAdmin.v0",
        userDid: BRIDGE_BOT_DID,
      };

      await peer.sendEvent(space, event);

      // Update status to reflect the change
      bridgeStatus =
        bridgeStatus.type === "loaded"
          ? { ...bridgeStatus, hasFullWritePermissions: false }
          : bridgeStatus;

      toast.success("Revoked granted bot permissions.");
    } catch (error) {
      console.error("Failed to revoke bot permissions:", error);
      toast.error("Failed to revoke bot permissions. Please try again.");
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      console.log("Text copied to clipboard");
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
  onMount(() => {
    let interval: undefined | ReturnType<typeof setInterval>;
    const updateStatus = () => {
      if (document.visibilityState == "visible") {
        console.log("checking discord bridge status");
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
  $effect(() => {
    space;
    updateBridgeStatus();
  });
</script>

{#snippet bridgeStatusBadge()}
  {#if bridgeStatus.type == "checking"}
    <Badge variant="yellow">checking</Badge>
  {:else if bridgeStatus.type == "loaded"}
    {#if bridgeStatus.guildId}
      <Badge variant="green">bridged</Badge>
    {:else}
      <Badge>not bridged</Badge>
    {/if}
  {:else if bridgeStatus.type == "error_checking"}
    <Badge variant="red">error connecting to bridge</Badge>
  {/if}
{/snippet}

{#if bridgeStatus.type == "loaded" && bridgeStatus.guildId}
  <form class="pt-4">
    <div class="space-y-12">
      <h2
        class="text-xl/7 font-bold text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        Discord Bridge
        {@render bridgeStatusBadge()}
      </h2>

      <p class="text-base/8">
        The Discord bridge is connected! This Roomy Space is bridge to your <a
          class="text-accent-500 underline underline-offset-3"
          href={`https://discord.com/channels/${bridgeStatus.guildId}`}
          target="_blank">Discord server</a
        >. You can disconnect it by going to Discord and running the slash
        command:
        <InlineMono>/disconnect-roomy-space</InlineMono>.
      </p>
    </div>
  </form>
{:else}
  <form class="pt-4">
    <div class="space-y-12">
      <h2
        class="text-base/7 font-semibold text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        Discord Bridge
        {@render bridgeStatusBadge()}
      </h2>

      <div class="flex flex-col justify-center gap-8">
        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            <span class="pr-1">
              {bridgeStatus.type == "loaded"
                ? bridgeStatus.hasFullWritePermissions
                  ? "✅"
                  : ""
                : ""}
            </span>
            1. Grant bot admin access to your Roomy space</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            In order to bridge channels, threads, and messages the bridge must
            have admin access to your Roomy space.
          </p>

          <div class="mt-4">
            <Button
              disabled={bridgeStatus.type == "loaded"
                ? bridgeStatus.hasFullWritePermissions
                : true}
              onclick={grantBotPermissions}>Grant Access</Button
            >
            <Button
              disabled={bridgeStatus.type == "loaded"
                ? !bridgeStatus.hasFullWritePermissions
                : true}
              onclick={revokeBotPermissions}>Revoke Access</Button
            >
          </div>
        </div>

        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            <span class="pr-1">
              {bridgeStatus.type == "loaded"
                ? bridgeStatus.guildId
                  ? "✅"
                  : ""
                : ""}
            </span>
            2. Invite bot to your Discord server</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            You need to be a server admin to add the bot. Please allow all
            requested permissions. Click the button below and select your
            server.
          </p>

          <div class="mt-2">
            {#if bridgeStatus.type == "loaded"}
              <Button
                target="_blank"
                href={`https://discord.com/oauth2/authorize?client_id=${bridgeStatus.appId}`}
                >Invite Bot</Button
              >
            {:else if bridgeStatus.type == "checking"}
              <Button disabled={true}>Loading...</Button>
            {:else if bridgeStatus.type == "error_checking"}
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
              {bridgeStatus.type == "loaded"
                ? bridgeStatus.guildId
                  ? "✅"
                  : ""
                : ""}
            </span>
            3. Connect your Roomy space to your Discord server</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Finish by running the <InlineMono>/connect-roomy-space</InlineMono> slash
            command in your Discord server to connect the space. It will require
            you to specify your space ID.
          </p>
          <div class="flex gap-2 items-center mt-4 ml-4">
            <strong>space-id:</strong>
            <InlineMono>{space}</InlineMono>
            <Button size="icon" onclick={() => copyToClipboard(space || "")}
              ><IconCopy /></Button
            >
          </div>
        </div>
      </div>
    </div>
  </form>
{/if}
