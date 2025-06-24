<script lang="ts">
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";
  import { onMount, getContext } from "svelte";
  import BridgeCard from "$lib/components/BridgeCard.svelte";
  import DiscordInstructions from "$lib/components/DiscordInstructions.svelte";

  let isLoading = $state(false);
  // Get the Jazz account from context
  const me = getContext('jazzAccount') as any;

  onMount(() => {
    user.init();
  });

  async function handleSignIn() {
    isLoading = true;
    try {
      await user.signInWithBluesky();
    } catch (e: unknown) {
      console.error(e);
    }
    isLoading = false;
  }

  function handleBridgeConnected() {
    console.log('Bridge connected successfully');
  }

  function handleBridgeDisconnected() {
    console.log('Bridge disconnected successfully');
  }
</script>

<div class="dz-hero bg-base-200 min-h-screen">
  <div class="dz-hero-content">
    <div class="flex flex-col gap-8 items-center max-w-4xl">
      <!-- Header -->
      <div class="text-center">
        <h1 class="text-5xl font-bold text-center mb-4">
          Discord Bridge 🌉
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center text-base-content/80">
          Connect your Discord server with Roomy spaces. Bridge conversations and build stronger communities across platforms.
        </p>
      </div>

      {#if user.session && me.current}
        <div class="w-full max-w-2xl">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-2xl font-bold">Your Spaces</h2>
            <p class="text-sm text-base-content/60">
              Logged in as {user.profile.data?.handle}
            </p>
          </div>          <div class="flex flex-col gap-2">
            {#if me.current?.profile.joinedSpaces && me.current.profile.joinedSpaces.length > 0}
              {#each me.current.profile.joinedSpaces as spaceRef}
                {#if spaceRef}
                  <BridgeCard
                    spaceId={spaceRef.id}
                    on:connected={handleBridgeConnected}
                    on:disconnected={handleBridgeDisconnected}
                  />
                {/if}
              {/each}
            {:else}
              <div class="dz-card bg-base-100 border border-base-300">
                <div class="dz-card-body p-4 text-center">
                  <p class="text-base-content/70">No spaces found. Create or join a space in the main Roomy app first.</p>
                </div>
              </div>
            {/if}
          </div>
          
          <DiscordInstructions />
          
          <div class="mt-6 text-center">
            <Button.Root
              onclick={user.logout}
              class="dz-btn dz-btn-ghost"
            >
              Logout
            </Button.Root>
          </div>
        </div>
      {:else}

        <!-- CTA Section -->
        <div class="flex flex-col gap-4 items-center">
          <div class="divider max-w-xs"></div>
          
          <Button.Root
            onclick={handleSignIn}
            class="dz-btn dz-btn-primary dz-btn-lg"
            disabled={isLoading}
          >
            {#if isLoading}
              <span class="dz-loading dz-loading-spinner dz-loading-sm mr-2"></span>
            {/if}
            <Icon icon="simple-icons:bluesky" class="mr-2" />
            Sign in with Bluesky
          </Button.Root>
          
          <p class="text-sm text-base-content/60">
            Connect with your Bluesky account to access your Roomy spaces
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>
