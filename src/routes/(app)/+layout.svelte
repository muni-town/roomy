<script lang="ts">
  import "../../app.css";
  import { onMount } from "svelte";
  import { browser, dev } from "$app/environment";
  
  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { Button, ToggleGroup } from "bits-ui";
  
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle, derivePromise, navigate } from "$lib/utils.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import { Space } from "@roomy-chat/sdk";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";

  const { children } = $props();

  let handleInput = $state("");
  let loginLoading = $state(false);

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let userInitComplete = $state(false);

  const spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );

  onMount(async () => {
    await user.init();
    userInitComplete = true;

    if (!dev && browser) {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only", // or 'always' to create profiles for anonymous users as well
      });
    }
  });

  $effect(() => {
    if (userInitComplete && !user.session) {
      user.isLoginDialogOpen = true;
    }
  });

  async function createSpace() {
    if (!newSpaceName || !user.agent || !g.roomy) return;
    const space = await g.roomy.create(Space);
    space.name = newSpaceName;
    space.admins((x) => user.agent && x.push(user.agent.assertDid));
    space.commit();

    g.roomy.spaces.push(space);
    g.roomy.commit();
    newSpaceName = "";

    isNewSpaceDialogOpen = false;
  }

  let loginError = $state("");
  async function login() {
    loginLoading = true;

    try {
      handleInput = cleanHandle(handleInput);
      await user.loginWithHandle(handleInput);
    } catch (e: unknown) {
      console.error(e);
      loginError = e instanceof Error ? e.message.toString() : "Unknown error";
    }

    loginLoading = false;
  }
</script>

<svelte:head>
  <title>Roomy</title>
</svelte:head>

{#if dev}
  <RenderScan />
{/if}

<!-- Container -->
<div class="flex w-screen h-screen bg-base-100">
  <Toaster />
  <!-- Server Bar -->

  <aside
    class="w-fit col-span-2 flex flex-col justify-between px-0 md:px-4 py-8 items-center border-r-2 border-base-200 h-screen overflow-y-auto overflow-x-hidden"
  >
    <ToggleGroup.Root
      type="single"
      value={g.currentCatalog}
      class="flex flex-col gap-1 items-center"
    >
      <ToggleGroup.Item
        value="home"
        onclick={() => navigate("home")}
        class="btn btn-ghost size-14 data-[state=on]:border-accent"
      >
        <Icon icon="iconamoon:home-fill" font-size="1.5em" />
      </ToggleGroup.Item>

      <div class="divider my-0"></div>

      {#each spaces.value as space, i}
        <SidebarSpace {space} {i} />
      {/each}
    </ToggleGroup.Root>

    <section class="menu gap-3">
      <ThemeSelector />
      <Dialog
        title="Create Space"
        description="Create a new public chat space"
        bind:isDialogOpen={isNewSpaceDialogOpen}
        disabled={!user.session}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Space"
            class="btn btn-ghost w-fit"
            disabled={!user.session}
          >
            <Icon icon="basil:add-solid" font-size="2em" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createSpace}>
          <input
            bind:value={newSpaceName}
            placeholder="Name"
            class="input w-full"
          />
          <Button.Root disabled={!newSpaceName} class="btn btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Space
          </Button.Root>
        </form>
      </Dialog>

      <Dialog
        title={user.session ? "Log Out" : "Log In"}
        description={user.session
          ? `Logged in as ${user.profile.data?.handle}`
          : "Log in with AT Protocol"}
        bind:isDialogOpen={user.isLoginDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root class="btn btn-ghost w-fit">
            <AvatarImage
              handle={user.profile.data?.handle || ""}
              avatarUrl={user.profile.data?.avatar}
            />
          </Button.Root>
        {/snippet}

        {#if user.session}
          <section class="flex flex-col gap-4">
            <Button.Root onclick={user.logout} class="btn btn-error">
              Log Out
            </Button.Root>
          </section>
        {:else}
          <form class="flex flex-col gap-4" onsubmit={login}>
            {#if loginError}
              <p class="text-error">{loginError}</p>
            {/if}
            <input
              bind:value={handleInput}
              placeholder="Handle (eg alice.bsky.social)"
              class="input w-full"
            />
            <Button.Root
              disabled={loginLoading || !handleInput}
              class="btn btn-primary"
            >
              {#if loginLoading}
                <span class="loading loading-spinner"></span>
              {/if}
              Log In with Bluesky
            </Button.Root>
          </form>
        {/if}
      </Dialog>
    </section>
  </aside>

  {@render children()}
</div>
