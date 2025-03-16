<script lang="ts">
  import "../../app.css";
  import { ulid } from "ulidx";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { dev } from "$app/environment";
  import { goto } from "$app/navigation";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle } from "$lib/utils";
  import { themeChange } from "theme-change";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { AvatarPixel } from "svelte-boring-avatars";
  import { Avatar, Button, ToggleGroup } from "bits-ui";

  import { RoomyPdsStorageAdapter } from "$lib/autodoc-storage";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";

  let { children } = $props();

  let handleInput = $state("");
  let loginLoading = $state(false);
  let isLoginDialogOpen = $state(!user.session);

  let newSpaceName = $state("");
  let deleteLoading = $state(false);
  let isNewSpaceDialogOpen = $state(false);

  let servers: string[] = $derived(
    g.catalog?.view.spaces.map((x) => x.id) || [],
  );
  let currentCatalog = $state("");

  $effect(() => {
    if (page.params.space) { currentCatalog = page.params.space; }
    else if (page.url.pathname === "/home" ) { currentCatalog = "home"; }
  });

  onMount(async () => {
    await user.init();
  });

  onMount(() => { themeChange(false); });

  onMount(() => {
    if (page.params.did) {
      currentCatalog = "dm";
    } else if (page.params.space) {
      currentCatalog = page.params.space;
    }
  });

  $effect(() => {
    if (user.session) isLoginDialogOpen = false;
  });

  async function createSpace() {
    if (!newSpaceName) return;
    let id = ulid();
    if (!g.catalog) return;
    g.catalog.change((doc) => {
      doc.spaces.push({
        id,
        knownMembers: [],
      });
    });
    setTimeout(() => {
      g.spaces[id].change((doc) => {
        doc.name = newSpaceName;
        doc.admins.push(user.agent!.assertDid);
      });
      newSpaceName = "";
    }, 0);
    isNewSpaceDialogOpen = false;
  }

  async function deleteData(kind: "all" | "local") {
    deleteLoading = true;

    if (kind == "all" && user.agent?.did) {
      await new RoomyPdsStorageAdapter(user.agent!).removeRange([]);
    }

    localStorage.clear();
    indexedDB.databases().then((dbs) => {
      dbs.forEach((db) => {
        if (db.name) indexedDB.deleteDatabase(db.name);
      });
    });

    window.location.reload();
  }

  let loginError = $state("");
  async function login() {
    loginLoading = true;

    try {
      handleInput = cleanHandle(handleInput);
      await user.loginWithHandle(handleInput);
    } catch (e: any) {
      console.error(e);
      loginError = e.toString();
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
    class="w-fit col-span-2 flex flex-col justify-between px-4 py-8 items-center border-r-2 border-base-200"
  >
    <ToggleGroup.Root
      type="single"
      value={currentCatalog}
      class="flex flex-col gap-2 items-center"
    >
      <ToggleGroup.Item
        value="home"
        onclick={() => goto("/home")}
        class="btn btn-ghost size-16 data-[state=on]:border-accent"
      >
        <Icon icon="iconamoon:home-fill" font-size="2em" />
      </ToggleGroup.Item>

      <div class="divider mt-0 mb-1"></div>

      {#each servers as server}
        {@const space = g.spaces[server]}
        {#if space}
          <ToggleGroup.Item
            onclick={() => goto(`/space/${server}`)}
            value={server}
            title={space.view.name}
            class="btn btn-ghost size-16 data-[state=on]:border-primary"
          >
            <!-- TODO: Use server avatar -->
            <Avatar.Root>
              <Avatar.Image />
              <Avatar.Fallback>
                <AvatarPixel name={server} />
              </Avatar.Fallback>
            </Avatar.Root>
          </ToggleGroup.Item>
        {/if}
      {/each}
    </ToggleGroup.Root>

    <section class="menu gap-3">
      <ThemeSelector />
      <Dialog
        title="Create Space"
        description="Create a new public chat space"
        bind:isDialogOpen={isNewSpaceDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Space"
            class="btn btn-ghost w-fit"
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

      <Dialog title="Delete Data">
        {#snippet dialogTrigger()}
          <Button.Root class="btn btn-ghost w-fit">
            <Icon icon="ri:alarm-warning-fill" class="text-2xl" />
          </Button.Root>
        {/snippet}

        <div class="flex flex-col items-center gap-4">
          <p class="text-sm">
            <strong>Warning:</strong> This will delete the Roomy data from this device
            and from your AtProto PDS if you chose.
          </p>
          <p class="text-sm">
            Roomy is currently <em>extremely</em> experimental, so until it gets
            a little more stable it may be necessary to reset all of your data in
            order to fix a problem after an update of Roomy is published.
          </p>
          <Button.Root
            onclick={() => deleteData("local")}
            class="btn btn-error"
            disabled={deleteLoading}
          >
            {#if deleteLoading}
              <span class="loading loading-spinner"></span>
            {/if}
            Delete Local Data 
          </Button.Root>
          <Button.Root
            onclick={() => deleteData("all")}
            class="btn btn-error"
            disabled={deleteLoading}
          >
            {#if deleteLoading}
              <span class="loading loading-spinner"></span>
            {/if}
            Delete Local and PDS Data
          </Button.Root>
        </div>
      </Dialog>

      {#if dev}
        <Button.Root onclick={() => goto("/dev")} class="btn btn-ghost">
          <Icon
            icon="fluent:window-dev-tools-16-regular"
            class="text-2xl"
          />
        </Button.Root>
      {/if}

      <Dialog
        title={user.session
          ? `Logged In As ${user.profile.data?.handle}`
          : "Login with AT Protocol"
        }
        bind:isDialogOpen={isLoginDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            class="btn btn-ghost w-fit" 
          >
            <AvatarImage
              handle={user.profile.data?.handle || ""}
              avatarUrl={user.profile.data?.avatar}
            />
          </Button.Root>
        {/snippet}

        {#if user.session}
          <section class="flex flex-col gap-4">
            <Button.Root
              onclick={user.logout}
              class="btn btn-error"
            >
              Logout
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
            <Button.Root disabled={loginLoading || !handleInput} class="btn btn-primary">
              {#if loginLoading}
                <span class="loading loading-spinner"></span>
              {/if}
              Login with Bluesky
            </Button.Root>
          </form>
        {/if}
      </Dialog>
    </section>
  </aside>

  {@render children()}
</div>