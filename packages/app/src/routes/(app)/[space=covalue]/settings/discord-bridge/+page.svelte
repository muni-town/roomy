<script lang="ts">
  import { page } from "$app/state";
  import { Badge, Button, Input } from "@fuxui/base";
  import {
    DiscordBridgeRequest,
    Group,
    WorkerAccount,
    discordBridgeBotAccountId,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import { onMount } from "svelte";
  import toast from "svelte-french-toast";

  let guildId = $state("");

  let isSendingRequest = $state(false);

  let discordBridgeBotAccount = $derived(
    new CoState(WorkerAccount, discordBridgeBotAccountId, {
      resolve: {
        profile: {
          requests: {
            $onError: null,
            $each: true,
          },
        },
      },
    }),
  );

  let existingRequest = $derived(
    discordBridgeBotAccount.current?.profile.requests?.find(
      (request) => request.roomySpaceId === page.params.space,
    ),
  );

  async function requestBridge() {
    if (!page.params.space || !guildId) {
      toast.error("Please fill in all fields");
      return;
    }

    if (!discordBridgeBotAccount.current) {
      toast.error("Couldn't find discord bridge bot account");
      return;
    }
    isSendingRequest = true;

    let group = Group.create();
    group.addMember(discordBridgeBotAccount.current, "writer");

    const request = DiscordBridgeRequest.create(
      {
        discordGuildId: guildId,
        roomySpaceId: page.params.space,
        status: "requested",
      },
      group,
    );

    discordBridgeBotAccount.current.profile.requests?.push(request);

    isSendingRequest = false;

    toast.success("Bridge request sent");
  }

  let botStatus: "loading" | "online" | "offline" = $state("loading");
  async function checkBotStatus() {
    try {
      // add random id to avoid service worker caching
      const res = await fetch(
        "http://localhost:3001/health?id=" + Math.random(),
        {
          cache: "no-store",
        },
      );
      const body = await res.json();
      botStatus = body.status === "ok" ? "online" : "offline";
    } catch (err) {
      console.error("Network error:", err);
      botStatus = "offline";
    }
  }

  onMount(() => {
    checkBotStatus();
  });
</script>

{#if discordBridgeBotAccount.current?.profile}
  <div></div>
{/if}

{#if existingRequest}
  <form class="pt-4">
    <div class="space-y-12">
      <h2
        class="text-base/7 font-semibold text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        Discord Bridge

        {#if botStatus === "loading"}
          <Badge variant="yellow">loading</Badge>
        {:else if botStatus === "offline"}
          <Badge variant="red">offline</Badge>
        {:else}
          <Badge variant="green">online</Badge>
        {/if}
      </h2>
    </div>
  </form>
{:else}
  <form class="pt-4">
    <div class="space-y-12">
      <h2
        class="text-base/7 font-semibold text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        Discord Bridge

        {#if botStatus === "loading"}
          <Badge variant="yellow">loading</Badge>
        {:else if botStatus === "offline"}
          <Badge variant="red">offline</Badge>
        {:else}
          <Badge variant="green">online</Badge>
        {/if}
      </h2>

      <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >1. Add bot to your Discord Server</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            You need to be a server admin to add the bot, please allow all
            requested permissions. Click the button below and select your
            server.
          </p>

          <div class="mt-2">
            <Button
              target="_blank"
              href="https://discord.com/oauth2/authorize?client_id=1382088278001586307"
              >Add bot</Button
            >
          </div>
        </div>

        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >2. Enter your discord server ID</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Right click on your discord server and select "Copy Server ID",
            paste it below.
          </p>

          <div class="mt-2">
            <Input bind:value={guildId} class="w-full" />
          </div>
        </div>

        <div class="sm:col-span-4">
          <label
            for="username"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
            >3. Start Bridging</label
          >
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            Start bridging your discord server to your roomy space. All channels
            and threads that have the same name in both will be automatically
            bridged.
          </p>

          <div class="mt-4">
            <Button
              disabled={isSendingRequest}
              onclick={() => {
                requestBridge();
              }}
            >
              {#if isSendingRequest}
                Sending request...
              {:else}
                Start Bridge
              {/if}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </form>
{/if}
