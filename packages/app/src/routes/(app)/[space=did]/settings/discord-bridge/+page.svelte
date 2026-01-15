<script lang="ts">
  import { page } from "$app/state";
  import { env } from "$env/dynamic/public";
  import { Badge, Button, toast } from "@fuxui/base";
  import { onMount } from "svelte";
  import { backend } from "$lib/workers";
  import { newUlid, UserDid, StreamDid } from "@roomy/sdk";

  let space = $derived(page.params.space);
  let bridgeStatus:
    | { type: "checking" }
    | {
        type: "loaded";
        guildId: undefined | string;
        appId: string;
        bridgeDid: string;
        isBridgeAdmin: boolean;
      }
    | { type: "error_checking" }
    | { type: "granting" } = $state({
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
        `${env.PUBLIC_DISCORD_BRIDGE}/get-guild-id?spaceId=${page.params.space}`,
      );
      const { guildId }: { guildId?: string } = await gResp.json();

      // TODO: Query admin status from SQLite once we have the query
      const isBridgeAdmin = false;

      bridgeStatus = {
        type: "loaded",
        appId: info.discordAppId,
        bridgeDid: info.bridgeDid,
        guildId,
        isBridgeAdmin,
      };
    } catch (e) {
      bridgeStatus = {
        type: "error_checking",
      };
    }
  }

  async function grantBotPermissions() {
    if (bridgeStatus.type !== "loaded" || !space) return;

    const previousStatus = bridgeStatus;
    bridgeStatus = { type: "granting" };

    try {
      // Step 1: Tell the bridge to join the space
      const joinResp = await fetch(`${env.PUBLIC_DISCORD_BRIDGE}/join-space`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId: space }),
      });

      if (!joinResp.ok) {
        const err = await joinResp.json();
        throw new Error(err.error || "Failed to join space");
      }

      const { bridgeDid } = await joinResp.json();

      // Step 2: Add the bridge as an admin
      const spaceId = StreamDid.assert(space);
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.addAdmin.v0",
        userDid: UserDid.assert(bridgeDid),
      });

      toast.success("Successfully granted bot permissions.");
      await updateBridgeStatus();
    } catch (e) {
      console.error("Error granting bot permissions:", e);
      toast.error(
        `Failed to grant permissions: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
      bridgeStatus = previousStatus;
    }
  }

  async function revokeBotPermissions() {
    if (bridgeStatus.type !== "loaded" || !space) return;

    try {
      const spaceId = StreamDid.assert(space);
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.removeAdmin.v0",
        userDid: UserDid.assert(bridgeStatus.bridgeDid),
      });

      toast.success("Revoked bot permissions.");
      await updateBridgeStatus();
    } catch (e) {
      console.error("Error revoking bot permissions:", e);
      toast.error(
        `Failed to revoke permissions: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
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
  {:else if bridgeStatus.type == "granting"}
    <Badge variant="yellow">granting access...</Badge>
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
        class="text-base/7 font-semibold text-base-900 dark:text-base-100 flex items-center gap-2"
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
        <code class="bg-base-800 p-1 rounded">/disconnect-roomy-space</code>.
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
                ? bridgeStatus.isBridgeAdmin
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
            {#if bridgeStatus.type === "granting"}
              <Button disabled={true}>Granting Access...</Button>
            {:else}
              <Button
                disabled={bridgeStatus.type !== "loaded" ||
                  bridgeStatus.isBridgeAdmin}
                onclick={grantBotPermissions}>Grant Access</Button
              >
              <Button
                disabled={bridgeStatus.type !== "loaded" ||
                  !bridgeStatus.isBridgeAdmin}
                onclick={revokeBotPermissions}>Revoke Access</Button
              >
            {/if}
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
            Finish by running the <code
              class="bg-base-200 dark:bg-base-800 p-1 rounded"
              >/connect-roomy-space</code
            > slash command in your Discord server to connect the space. It will
            require you to specify your space ID.
          </p>
          <div class="flex gap-2 items-center mt-4 ml-4">
            <strong>space-id:</strong>
            <code class="m-3 p-2 bg-base-200 dark:bg-base-800 text-sm rounded"
              >{page.params.space}</code
            >
          </div>
        </div>
      </div>
    </div>
  </form>
{/if}
