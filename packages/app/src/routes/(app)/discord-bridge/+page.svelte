<script lang="ts">
  import { onMount } from "svelte";
  import { globalState } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { Space } from "@roomy-chat/sdk";
  import toast from "svelte-french-toast";
  import { discordBridgeService } from "$lib/discord-bridge/bridge-service";
  import { derivePromise } from "$lib/utils.svelte";

  let discordToken = $state("");
  let discordGuildId = $state("");
  let selectedSpace: Space | null = $state(null);
  const spaces = derivePromise(
    [],
    async () => (await globalState.roomy?.spaces.items()) || [],
  );

  let channels = $state<{ id: string; name: string }[]>([]);
  let discordChannels = $state<{ id: string; name: string }[]>([]);
  let isFetchingDiscordChannels = $state(false);
  let mappings = $state<
    {
      discordChannelId: string;
      discordChannelName: string;
      roomyChannelId: string;
      roomyChannelName: string;
    }[]
  >([]);
  let selectedDiscordChannel = $state("");
  let selectedRoomyChannel = $state("");

  // Add bridge status
  let bridgeStatus = $state({
    active: false,
    startedAt: null as Date | null,
  });

  onMount(async () => {
    user.init();

    // Load saved token if exists
    const savedToken = localStorage.getItem("discord-bridge-token");
    if (savedToken) {
      discordToken = savedToken;
    }

    // Load saved mappings if exists
    const savedMappings = localStorage.getItem("discord-bridge-mappings");
    if (savedMappings) {
      mappings = JSON.parse(savedMappings);
    }

    // Get current bridge status
    const currentStatus = await discordBridgeService.getBridgeStatus();
    bridgeStatus.active = currentStatus.active;
    bridgeStatus.startedAt = currentStatus.startedAt;
  });

  async function loadChannels() {
    if (!selectedSpace) return;

    const channelItems = await selectedSpace.channels.items();
    channels = channelItems.map((channel) => ({
      id: channel.id,
      name: channel.name,
    }));
  }

  async function fetchDiscordChannels() {
    if (!discordToken || !discordGuildId) {
      toast.error("Please enter both Discord token and Guild ID");
      return;
    }

    isFetchingDiscordChannels = true;

    try {
      const response = await fetch("/api/discord-channels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: discordToken,
          guildId: discordGuildId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch Discord channels");
      }

      const data = await response.json();
      discordChannels = data.channels;

      // Save token for convenience
      localStorage.setItem("discord-bridge-token", discordToken);

      toast.success("Successfully fetched Discord channels");
    } catch (error) {
      console.error(error);
      toast.error("Error fetching Discord channels");
    } finally {
      isFetchingDiscordChannels = false;
    }
  }

  function addChannelMapping() {
    if (!selectedDiscordChannel || !selectedRoomyChannel) {
      toast.error("Please select both a Discord and Roomy channel");
      return;
    }

    // Find channel names for display
    const discordChannel = discordChannels.find(
      (c) => c.id === selectedDiscordChannel,
    );
    const roomyChannel = channels.find((c) => c.id === selectedRoomyChannel);

    if (!discordChannel || !roomyChannel) {
      toast.error("Selected channels not found");
      return;
    }

    // Check if mapping already exists
    if (
      mappings.some(
        (m) =>
          m.discordChannelId === selectedDiscordChannel &&
          m.roomyChannelId === selectedRoomyChannel,
      )
    ) {
      toast.error("This channel mapping already exists");
      return;
    }

    // Add new mapping
    mappings = [
      ...mappings,
      {
        discordChannelId: selectedDiscordChannel,
        discordChannelName: discordChannel.name,
        roomyChannelId: selectedRoomyChannel,
        roomyChannelName: roomyChannel.name,
      },
    ];

    // Save mappings
    localStorage.setItem("discord-bridge-mappings", JSON.stringify(mappings));

    // Reset selections
    selectedDiscordChannel = "";
    selectedRoomyChannel = "";

    toast.success("Channel mapping added");
  }

  function removeMapping(index: number) {
    mappings = mappings.filter((_, i) => i !== index);
    localStorage.setItem("discord-bridge-mappings", JSON.stringify(mappings));
    toast.success("Mapping removed");
  }

  // Update the startBridge function to use the service
  async function startBridge() {
    if (mappings.length === 0) {
      toast.error("Add at least one channel mapping first");
      return;
    }

    const success = await discordBridgeService.start(discordToken, mappings);

    if (success) {
      // Update local status after successful start
      bridgeStatus.active = true;
      bridgeStatus.startedAt = new Date();
    }
  }

  // Update the stopBridge function to use the service
  async function stopBridge() {
    const stopped = await discordBridgeService.stop();

    if (stopped) {
      // Update local status after successful stop
      bridgeStatus.active = false;
      bridgeStatus.startedAt = null;
    }
  }

  $effect(() => {
    if (selectedSpace) {
      loadChannels();
    }
  });
</script>

<div class="container mx-auto p-4 max-w-4xl">
  <h1 class="text-3xl font-bold mb-6">Discord-Roomy Bridge</h1>

  <div class="bg-base-200 p-6 rounded-lg mb-6">
    <h2 class="text-2xl font-semibold mb-4">Discord Configuration</h2>

    <div class="form-control mb-4">
      <label class="label" for="discord-token">
        <span class="label-text">Discord Bot Token</span>
      </label>
      <input
        id="discord-token"
        type="password"
        class="dz-input dz-input-bordered w-full"
        placeholder="Enter Discord bot token"
        bind:value={discordToken}
      />
    </div>

    <div class="form-control mb-4">
      <label class="label" for="guild-id">
        <span class="label-text">Discord Guild ID</span>
      </label>
      <input
        id="guild-id"
        type="text"
        class="dz-input dz-input-bordered w-full"
        placeholder="Enter Discord guild ID"
        bind:value={discordGuildId}
      />
    </div>

    <button
      class="dz-btn dz-btn-primary"
      onclick={fetchDiscordChannels}
      disabled={isFetchingDiscordChannels}
    >
      {isFetchingDiscordChannels
        ? "Fetching Channels..."
        : "Fetch Discord Channels"}
    </button>
  </div>

  <div class="bg-base-200 p-6 rounded-lg mb-6">
    <h2 class="text-2xl font-semibold mb-4">Roomy Configuration</h2>

    <div class="form-control mb-4">
      <label class="label" for="space-select">
        <span class="label-text">Select Space</span>
      </label>
      <select
        id="space-select"
        class="dz-select dz-select-bordered w-full"
        bind:value={selectedSpace}
      >
        <option value={null}>Select a space</option>
        {#each spaces.value as space}
          <option value={space}>{space.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="bg-base-200 p-6 rounded-lg mb-6">
    <h2 class="text-2xl font-semibold mb-4">Channel Mapping</h2>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
      <div class="form-control">
        <label class="label" for="discord-channel">
          <span class="label-text">Discord Channel</span>
        </label>
        <select
          id="discord-channel"
          class="dz-select dz-select-bordered w-full"
          bind:value={selectedDiscordChannel}
        >
          <option value="">Select Discord channel</option>
          {#each discordChannels as channel}
            <option value={channel.id}>{channel.name}</option>
          {/each}
        </select>
      </div>

      <div class="form-control">
        <label class="label" for="roomy-channel">
          <span class="label-text">Roomy Channel</span>
        </label>
        <select
          id="roomy-channel"
          class="dz-select dz-select-bordered w-full"
          bind:value={selectedRoomyChannel}
        >
          <option value="">Select Roomy channel</option>
          {#each channels as channel}
            <option value={channel.id}>{channel.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <button class="dz-btn dz-btn-secondary" onclick={addChannelMapping}>
      Add Channel Mapping
    </button>
  </div>

  {#if mappings.length > 0}
    <div class="bg-base-200 p-6 rounded-lg mb-6">
      <h2 class="text-2xl font-semibold mb-4">Channel Mappings</h2>

      <div class="overflow-x-auto">
        <table class="dz-table w-full">
          <thead>
            <tr>
              <th>Discord Channel</th>
              <th>Roomy Channel</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each mappings as mapping, i}
              <tr>
                <td>{mapping.discordChannelName}</td>
                <td>{mapping.roomyChannelName}</td>
                <td>
                  <button
                    class="dz-btn dz-btn-sm dz-btn-error"
                    onclick={() => removeMapping(i)}
                    disabled={bridgeStatus.active}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="mt-6">
        {#if !bridgeStatus.active}
          <button class="dz-btn dz-btn-primary" onclick={startBridge}>
            Start Discord-Roomy Bridge
          </button>
        {:else}
          <div
            class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="flex items-center gap-2">
              <div class="w-3 h-3 bg-success rounded-full animate-pulse"></div>
              <span
                >Bridge active since {bridgeStatus.startedAt?.toLocaleString()}</span
              >
            </div>
            <button class="dz-btn dz-btn-warning" onclick={stopBridge}>
              Stop Bridge
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
