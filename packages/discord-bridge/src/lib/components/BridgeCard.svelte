<script lang="ts">
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import { createEventDispatcher } from 'svelte';
  import { CoState } from 'jazz-svelte';
  import { Space } from '../jazz/schema';

  interface Props {
    spaceId: string;
  }

  let { spaceId }: Props = $props();
  
  const dispatch = createEventDispatcher();

  // Load the space with channels resolved, like in the main app
  let space = $derived(
    new CoState(Space, spaceId, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );
  let showConfig = $state(false);
  let discordToken = $state('');
  let guildId = $state('');
  let selectedChannelId = $state('');
  let isConnecting = $state(false);
  let bridgeStatus = $state<{ active: boolean; error?: string }>({ active: false });

  // Get actual channels from the space - now properly resolved
  const availableChannels = $derived(
    space.current?.channels && space.current.channels.length > 0
      ? space.current.channels
          .filter(channel => !channel?.softDeleted) // Filter out soft-deleted channels
          .map(channel => ({
            id: channel.id,
            name: channel.name
          }))
      : []
  );

  // Check bridge status on mount
  async function checkBridgeStatus() {
    if (!guildId) return;
    
    try {
      const response = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'status',
          spaceId,
          guildId
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        bridgeStatus = { active: result.status.active };
      }
    } catch (error) {
      console.error('Error checking bridge status:', error);
    }
  }  async function handleConnect() {
    if (!discordToken.trim() || !guildId.trim()) {
      alert('Please fill in all fields');
      return;
    }

    if (!availableChannels || availableChannels.length === 0) {
      alert('No channels available in this space. Please create a channel first.');
      return;
    }

    // Use first available channel if none selected
    const channelId = selectedChannelId || availableChannels[0]?.id;
    
    if (!channelId) {
      alert('No valid channel selected');
      return;
    }

    isConnecting = true;
    try {
      const response = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          spaceId,
          channelId,
          discordToken: discordToken.trim(),
          guildId: guildId.trim()
        })
      });

      if (response.ok) {
        const result = await response.json();
        bridgeStatus = { active: true };
        showConfig = false;
        discordToken = '';
        guildId = '';
        selectedChannelId = '';
        dispatch('connected');
      } else {
        const error = await response.json();
        alert(`Failed to connect: ${error.error}`);
        bridgeStatus = { active: false, error: error.error };
      }
    } catch (error) {
      console.error('Bridge connection failed:', error);
      alert(`Failed to connect: ${error}`);
      bridgeStatus = { active: false, error: String(error) };
    } finally {
      isConnecting = false;
    }
  }
  async function handleDisconnect() {
    if (!bridgeConfig) return;
    
    const result = await stopBridge(spaceId, bridgeConfig.guildId);
    
    if (result.success) {
      dispatch('disconnected');
    } else {
      alert(`Failed to disconnect: ${result.error}`);
    }
  }

  function handleCancel() {
    showConfig = false;
    discordToken = '';
    guildId = '';
    selectedChannelId = '';
  }
</script>

<div class="dz-card bg-base-100 border border-base-300">
  <div class="dz-card-body p-4">
    <div class="flex items-center justify-between">      <div class="flex-1">
        <h3 class="font-semibold">{space.current?.name || 'Loading...'}</h3>
        <p class="text-sm text-base-content/70">{space.current?.description || "No description"}</p>        {#if bridgeStatus.active}
          <div class="flex items-center gap-2 mt-2">
            <div class="w-2 h-2 bg-green-500 rounded-full"></div>
            <span class="text-sm text-green-600">Connected to Discord</span>
          </div>
        {:else if bridgeStatus.error}
          <div class="flex items-center gap-2 mt-2">
            <div class="w-2 h-2 bg-red-500 rounded-full"></div>
            <span class="text-sm text-red-600">Connection Error</span>
            {#if bridgeStatus.error}
              <span class="text-xs text-red-500">({bridgeStatus.error})</span>
            {/if}
          </div>{:else if !availableChannels || availableChannels.length === 0}
          <div class="flex items-center gap-2 mt-2">
            <div class="w-2 h-2 bg-yellow-500 rounded-full"></div>
            <span class="text-sm text-yellow-600">
              {#if !space.current}
                Loading channels...
              {:else}
                No channels available - create a channel first
              {/if}
            </span>
          </div>
        {/if}
      </div>
      
      <div class="flex gap-2">        {#if bridgeStatus.active}
          <Button.Root
            onclick={handleDisconnect}
            class="dz-btn dz-btn-sm dz-btn-error"
          >
            <Icon icon="lucide:unlink" class="w-4 h-4 mr-1" />
            Disconnect
          </Button.Root>{:else}
          <Button.Root
            onclick={() => showConfig = true}
            class="dz-btn dz-btn-sm dz-btn-primary"
            disabled={isConnecting || !space.current || !availableChannels || availableChannels.length === 0}
          >
            <Icon icon="lucide:link" class="w-4 h-4 mr-1" />
            {#if !space.current}
              Loading...
            {:else}
              Connect
            {/if}
          </Button.Root>
        {/if}
      </div>
    </div>

    {#if showConfig}
      <div class="mt-4 p-4 bg-base-200 rounded-lg">
        <h4 class="font-medium mb-4">Discord Configuration</h4>
        
        <div class="flex flex-col gap-4">          <div>
            <label class="dz-label" for="discord-token">
              <span class="dz-label-text">Discord Bot Token</span>
            </label>
            <input
              id="discord-token"
              type="password"
              bind:value={discordToken}
              placeholder="Your Discord bot token"
              class="dz-input dz-input-bordered w-full"
            />
            <div class="dz-label">
              <span class="dz-label-text-alt">
                <a href="https://discord.com/developers/applications" target="_blank" class="link">
                  Get your bot token from Discord Developer Portal
                </a>
              </span>
            </div>
          </div>

          <div>
            <label class="dz-label" for="guild-id">
              <span class="dz-label-text">Discord Guild (Server) ID</span>
            </label>
            <input
              id="guild-id"
              type="text"
              bind:value={guildId}
              placeholder="Your Discord server ID"
              class="dz-input dz-input-bordered w-full"
            />
            <div class="dz-label">
              <span class="dz-label-text-alt">
                Enable Developer Mode in Discord, right-click your server, and copy ID
              </span>
            </div>
          </div>          {#if availableChannels && availableChannels.length > 1}
            <div>
              <label class="dz-label" for="channel-select">
                <span class="dz-label-text">Roomy Channel</span>
              </label>
              <select id="channel-select" bind:value={selectedChannelId} class="dz-select dz-select-bordered w-full">
                <option value="">Select a channel (default: {availableChannels[0]?.name})</option>
                {#each availableChannels as channel}
                  <option value={channel.id}>{channel.name}</option>
                {/each}
              </select>
            </div>
          {/if}

          <div class="flex gap-2 justify-end">
            <Button.Root
              onclick={handleCancel}
              class="dz-btn dz-btn-ghost dz-btn-sm"
            >
              Cancel
            </Button.Root>
            <Button.Root
              onclick={handleConnect}
              class="dz-btn dz-btn-primary dz-btn-sm"
              disabled={isConnecting || !discordToken.trim() || !guildId.trim()}
            >
              {#if isConnecting}
                <span class="dz-loading dz-loading-spinner dz-loading-sm mr-2"></span>
              {/if}
              Connect Bridge
            </Button.Root>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
