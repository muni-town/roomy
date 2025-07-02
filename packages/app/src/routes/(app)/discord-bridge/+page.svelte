<script lang="ts">
  import { onMount } from "svelte";
  import toast from "svelte-french-toast";
  import { RoomyAccount } from "$lib/jazz/schema";
  import { AccountCoState } from "jazz-svelte";
  import { env } from "$env/dynamic/public";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: {
          $each: {
            channels: {
              $each: true,
              $onError: null,
            },
          },
          $onError: null,
        },
      },
      root: true,
    },
  });

  const BRIDGE_SERVICE_URL = env.PUBLIC_BRIDGE_SERVICE_URL || 'http://localhost:3001';

  let bridges: any[] = $state([]);
  let showCreateForm = $state(false);
  let userSpaces: any[] = $state([]);
  let selectedSpace: any = $state(null);
  let selectedChannel: any = $state(null);
  let serverStatus = $state({ online: false, activeBridges: 0 });

  let newBridge = $state({
    name: "",
    discordToken: "",
    discordGuildId: "",
    roomySpaceId: "",
    roomyChannelId: "",
  });

  async function checkServerStatus() {
    try {
      const response = await fetch(`${BRIDGE_SERVICE_URL}/health`);
      if (response.ok) {
        const statusResponse = await fetch(`${BRIDGE_SERVICE_URL}/status`);
        const statusData = await statusResponse.json();
        serverStatus = { 
          online: true, 
          activeBridges: statusData.activeBridges || 0 
        };
      } else {
        serverStatus = { online: false, activeBridges: 0 };
      }
    } catch (error) {
      console.error('Bridge service not available:', error);
      serverStatus = { online: false, activeBridges: 0 };
    }
  }

  async function startBridgeService(bridgeConfig: any) {
    try {
        console.log({
          id: bridgeConfig.id,
          spaceId: bridgeConfig.roomySpaceId,
          channelId: bridgeConfig.roomyChannelId,
          guildId: bridgeConfig.discordGuildId,
          discordToken: bridgeConfig.discordToken,
          name: bridgeConfig.name,
          userId: me.current?.id || ""
        })
      const response = await fetch(`${BRIDGE_SERVICE_URL}/bridges`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: bridgeConfig.id,
          spaceId: bridgeConfig.roomySpaceId,
          channelId: bridgeConfig.roomyChannelId,
          guildId: bridgeConfig.discordGuildId,
          discordToken: bridgeConfig.discordToken,
          name: bridgeConfig.name,
          userId: me.current?.id || ""
        }),
      });

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Failed to start bridge');
      }

      return result;
    } catch (error) {
      console.error('Error starting bridge service:', error);
      throw error;
    }
  }

  async function stopBridgeService(bridgeKey: string) {
    try {
      const response = await fetch(`${BRIDGE_SERVICE_URL}/bridges/${bridgeKey}`, {
        method: 'DELETE',
      });

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Failed to stop bridge');
      }

      return result;
    } catch (error) {
      console.error('Error stopping bridge service:', error);
      throw error;
    }
  }

  async function validateDiscordToken(token: string, guildId: string) {
    try {
      const response = await fetch(`${BRIDGE_SERVICE_URL}/validate-discord`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          discordToken: token,
          guildId: guildId
        }),
      });

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Failed to validate Discord token');
      }

      return result;
    } catch (error) {
      console.error('Error validating Discord token:', error);
      throw error;
    }
  }

  onMount(async () => {
    await loadUserSpaces();
    await loadBridges();
    await checkServerStatus();
    
    setInterval(checkServerStatus, 10000);
  });

  $effect(() => {
    if (me.current?.profile?.joinedSpaces && userSpaces.length === 0) {
      loadUserSpaces();
    }
  });

  async function loadUserSpaces() {
    try {
      if (!me.current?.profile?.joinedSpaces) return;
      
      // Load user's joined spaces
      const spacesList = me.current.profile.joinedSpaces;
      userSpaces = [];
      console.log('Loading user spaces:', spacesList);
      
      for (const space of spacesList) {
        if (space && space.id) {
          console.log('Space ID:', space.id, 'Name:', space.name);
          // Keep the original space object - don't copy it to maintain reactivity
          userSpaces.push(space);
        } else {
          console.warn('Skipping space with invalid ID:', space);
        }
      }
      
      console.log('Loaded user spaces:', userSpaces);
    } catch (error) {
      console.error("Error loading user spaces:", error);
    }
  }

  async function onSpaceChange() {
    selectedSpace = userSpaces.find(s => s.id === newBridge.roomySpaceId) || null;
    selectedChannel = null;
    newBridge.roomyChannelId = "";
  }

  async function onChannelChange() {
    if (!selectedSpace) {
      selectedChannel = null;
      newBridge.roomyChannelId = "";
      return;
    }
    selectedChannel = selectedSpace.channels.find((c: any) => c.id === newBridge.roomyChannelId) || null;
  }

  async function loadBridges() {
    try {
      // Load from localStorage for persistence
      const savedBridges = localStorage.getItem('discord-bridges');
      if (savedBridges) {
        try {
          bridges = JSON.parse(savedBridges);
        } catch (e) {
          bridges = [];
        }
      } else {
        bridges = [];
      }
      
      // Check which bridges are actually running in the service
      if (serverStatus.online) {
        try {
          const response = await fetch(`${BRIDGE_SERVICE_URL}/bridges`);
          if (response.ok) {
            const serviceData = await response.json();
            const activeBridgeIds = serviceData.bridges.map((b: any) => b.id);
            
            // Update bridge status based on service status
            bridges = bridges.map(bridge => ({
              ...bridge,
              enabled: activeBridgeIds.includes(bridge.bridgeKey || `${bridge.roomySpaceId}-${bridge.discordGuildId}`)
            }));
          }
        } catch (error) {
          console.error('Error checking service bridge status:', error);
        }
      }
      
    } catch (error) {
      console.error("Error loading bridges:", error);
      bridges = [];
    }
  }
  

  async function createBridge() {
    
    try {
      if (!newBridge.name) {
        toast.error("Bridge name is required");
        return;
      }
      
      if (!newBridge.discordToken) {
        toast.error("Discord token is required");
        return;
      }
      
      if (!newBridge.discordGuildId) {
        toast.error("Discord Guild ID is required");
        return;
      }

      if (!selectedSpace) {
        toast.error("Please select a Roomy space");
        return;
      }

      if (!newBridge.roomyChannelId) {
        toast.error("Please select a Roomy channel");
        return;
      }

      if (!serverStatus.online) {
        toast.error("Bridge service is not running. Please start the service first to validate Discord token.");
        return;
      }

      // Validate Discord token and guild access before creating the bridge
      try {
        console.log('Validating Discord token and guild access...');
        const validationResult = await validateDiscordToken(newBridge.discordToken, newBridge.discordGuildId);
        
        if (!validationResult.valid) {
          toast.error(`Discord validation failed: ${validationResult.error}`);
          return;
        }
        
        console.log('Discord token validation successful:', validationResult.botInfo);
        
        toast.success("Discord token validation successful!");
        
        // Show bot info to user for confirmation
        const botInfo = validationResult.botInfo;
        const confirmMessage = `Discord bot validation successful!\n\nBot: ${botInfo.username}#${botInfo.discriminator}\nGuild: ${botInfo.guildName}\n\nProceed with creating the bridge?`;
        
        if (!confirm(confirmMessage)) {
          return;
        }
        
      } catch (error) {
        toast.error(`Failed to validate Discord token: ${(error as Error).message}`);
        return;
      }
      
      // Set the space ID from selected space
      newBridge.roomySpaceId = selectedSpace.id;
      if (selectedChannel) {
        newBridge.roomyChannelId = selectedChannel.id;
      }

      const bridgeConfig = {
        id: crypto.randomUUID(),
        ...newBridge,
        enabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ownerId: me.current?.id || "",
        bridgeKey: `${newBridge.roomySpaceId}-${newBridge.discordGuildId}` // Key used by bridge service
      };

      console.log('Bridge config created:', bridgeConfig);

      // Save to localStorage for persistence
      const savedBridges = localStorage.getItem('discord-bridges');
      let updatedBridges = [];
      if (savedBridges) {
        try {
          updatedBridges = JSON.parse(savedBridges);
        } catch (e) {
          updatedBridges = [];
        }
      }
      updatedBridges.push(bridgeConfig);
      localStorage.setItem('discord-bridges', JSON.stringify(updatedBridges));
      bridges = updatedBridges;
      
      console.log('Bridge saved, resetting form');
      
      // Reset form
      newBridge = {
        name: "",
        discordToken: "",
        discordGuildId: "",
        roomySpaceId: "",
        roomyChannelId: "",
      };
      selectedSpace = null;
      selectedChannel = null;
      showCreateForm = false;
      
      toast.success("Bridge configuration created successfully! Use the Enable button to start the bridge.");
    } catch (error) {
      console.error("Error creating bridge:", error);
      toast.error("Failed to create bridge configuration: " + (error as Error).message);
    }
  }

  async function toggleBridge(bridge: any) {
    try {
      if (!serverStatus.online) {
        toast.error("Bridge service is not running. Please start the service first.");
        return;
      }

      if (bridge.enabled) {
        // Stop the bridge
        await stopBridgeService(bridge.bridgeKey);
        bridge.enabled = false;
        toast.success(`Bridge ${bridge.name} stopped successfully`);
      } else {
        // Ensure all required fields are present with correct naming
        const bridgeConfig = {
          id: bridge.id,
          roomySpaceId: bridge.roomySpaceId,
          roomyChannelId: bridge.roomyChannelId,
          discordGuildId: bridge.discordGuildId,
          discordToken: bridge.discordToken,
          name: bridge.name
        };
        await startBridgeService(bridgeConfig);
        bridge.enabled = true;
        toast.success(`Bridge ${bridge.name} started successfully`);
      }
      
      bridge.updatedAt = new Date();
      
      // Update in localStorage
      bridges = [...bridges];
      localStorage.setItem('discord-bridges', JSON.stringify(bridges));
      
      // Update server status
      await checkServerStatus();
      
    } catch (error) {
      console.error("Error toggling bridge:", error);
      toast.error("Failed to toggle bridge: " + (error as Error).message);
    }
  }

  async function deleteBridge(bridgeId: string) {
    try {
      const bridge = bridges.find(b => b.id === bridgeId);
      
      // If bridge is enabled, stop it first
      if (bridge?.enabled && serverStatus.online) {
        try {
          await stopBridgeService(bridge.bridgeKey);
        } catch (error) {
          console.error('Error stopping bridge before deletion:', error);
        }
      }
      
      // Remove from local array
      bridges = bridges.filter(b => b.id !== bridgeId);
      
      // Update localStorage
      localStorage.setItem('discord-bridges', JSON.stringify(bridges));
      
      // Update server status
      await checkServerStatus();
      
      toast.success("Bridge configuration deleted");
    } catch (error) {
      console.error("Error deleting bridge:", error);
      toast.error("Failed to delete bridge configuration");
    }
  }
</script>

<svelte:head>
  <title>Discord Bridge Admin - Roomy</title>
</svelte:head>

<div class="max-w-2xl mx-auto px-4 py-8 space-y-8">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Discord Bridge Management</h1>
      <p class="text-sm text-gray-500">Connect your Roomy spaces with Discord channels for seamless communication.</p>
    </div>
    <button class="dz-btn dz-btn-primary" onclick={() => showCreateForm = !showCreateForm}>New Bridge</button>
  </div>

  {#if showCreateForm}
    <form class="space-y-4" onsubmit={(event ) => {
      event.preventDefault(); createBridge();
    }}>
      <div class="dz-form-control">
        <label class="dz-label" for="bridge-name">Bridge Name</label>
        <input id="bridge-name" class="dz-input dz-input-bordered" bind:value={newBridge.name} placeholder="My Discord Bridge" />
      </div>
      <div class="dz-form-control">
        <label class="dz-label" for="discord-token">Discord Bot Token</label>
        <input id="discord-token" type="password" class="dz-input dz-input-bordered" bind:value={newBridge.discordToken} placeholder="Bot token from Discord Developer Portal" />
      </div>
      <div class="dz-form-control">
        <label class="dz-label" for="discord-guild">Discord Guild ID</label>
        <input id="discord-guild" class="dz-input dz-input-bordered" bind:value={newBridge.discordGuildId} placeholder="123456789012345678" />
      </div>
      <div class="dz-form-control">
        <label class="dz-label" for="roomy-space">Select Roomy Space</label>
        <select id="roomy-space" class="dz-select dz-select-bordered" bind:value={newBridge.roomySpaceId} onchange={onSpaceChange}>
          <option value="">Choose a space...</option>
          {#each userSpaces as space}
            <option value={space.id}>{space.name}</option>
          {/each}
        </select>
      </div>
      <div class="dz-form-control">
        <label class="dz-label" for="roomy-channel">Select Roomy Channel (Required)</label>
        <select id="roomy-channel" class="dz-select dz-select-bordered" bind:value={newBridge.roomyChannelId} onchange={onChannelChange} disabled={!selectedSpace} required>
          <option value="">Choose a channel...</option>
          {#if selectedSpace?.channels}
            {#each selectedSpace.channels as channel}
              <option value={channel.id}>{channel.name || 'Unnamed Channel'}</option>
            {/each}
          {/if}
        </select>
      </div>
      <div class="flex gap-2">
        <button type="submit" class="dz-btn dz-btn-primary">Create Bridge</button>
        <button type="button" class="dz-btn" onclick={() => showCreateForm = false}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if bridges.length === 0}
    <div class="text-center text-gray-500 py-8">
      <div class="text-4xl mb-2">⚙️</div>
      <div>No bridges configured</div>
      <button class="dz-btn dz-btn-primary mt-4" onclick={() => showCreateForm = true}>Create Bridge</button>
    </div>
  {:else}
    <div class="space-y-4">
      {#each bridges as bridge (bridge.id)}
        <div class="border rounded p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2 bg-base-100">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="font-semibold">{bridge.name}</span>
              <span class="dz-badge {bridge.enabled ? 'dz-badge-success' : 'dz-badge-ghost'}">{bridge.enabled ? 'Active' : 'Inactive'}</span>
            </div>
            <div class="text-xs text-gray-500">
              Discord Guild: {bridge.discordGuildId} <br />
              Roomy Space: {bridge.roomySpaceId} <br />
              {#if bridge.roomyChannelId}Roomy Channel: {bridge.roomyChannelId} <br />{/if}
              Created: {new Date(bridge.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div class="flex gap-2 mt-2 md:mt-0">
            <button class="dz-btn dz-btn-sm {bridge.enabled ? 'dz-btn-warning' : 'dz-btn-success'}" onclick={() => toggleBridge(bridge)}>{bridge.enabled ? 'Disable' : 'Enable'}</button>
            <button class="dz-btn dz-btn-sm dz-btn-error" onclick={() => deleteBridge(bridge.id)}>🗑️</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="mt-8">
    <div class="font-semibold mb-1">Bridge Server Status</div>
    <div class="text-sm text-gray-500 mb-2">Monitor the status of your Discord bridge server.</div>
    <div class="flex flex-wrap gap-6 items-center">
      <div>Server Status: <span class="font-semibold">{serverStatus.online ? 'Running' : 'Offline'}</span></div>
      <div>Active Bridges: <span class="font-semibold">{serverStatus.activeBridges}</span></div>
      <div>Service URL: <span class="font-mono text-xs">{BRIDGE_SERVICE_URL}</span></div>
    </div>
  </div>
</div>


