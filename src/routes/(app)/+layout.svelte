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
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  import { Toaster } from "svelte-french-toast";
  import { AvatarPixel } from "svelte-boring-avatars";
  import { Avatar, Button, ToggleGroup } from "bits-ui";

  import { RoomyPdsStorageAdapter } from "$lib/autodoc-storage";

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

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  onMount(async () => {
    await user.init();
  });

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

<!-- Container -->
<div class="flex w-screen h-screen bg-violet-950">
  <Toaster />
  <!-- Server Bar -->

  <aside
    class="w-fit col-span-2 flex flex-col justify-between bg-violet-950 px-4 py-8 items-center border-r-2 border-violet-900"
  >
    <ToggleGroup.Root
      type="single"
      value={currentCatalog}
      class="flex flex-col gap-4 items-center"
    >
      <ToggleGroup.Item
        value="dm"
        onclick={() => goto("/dm")}
        class="capitalize hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white p-4 rounded-md"
      >
        <Avatar.Root>
          <Icon icon="ri:user-fill" font-size="2em" />
        </Avatar.Root>
      </ToggleGroup.Item>

      <div class="border-white border-t-1 w-[80%]"></div>

      {#each servers as server}
        {@const space = g.spaces[server]}
        {#if space}
          <ToggleGroup.Item
            onclick={() => goto(`/space/${server}`)}
            value={server}
            title={space.view.name}
            class="capitalize hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white p-4 rounded-md"
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

    <section class="flex flex-col gap-8 items-center">
      <Dialog
        title="Create Space"
        description="Create a new public chat space"
        bind:isDialogOpen={isNewSpaceDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            class="hover:scale-105 active:scale-95 transition-all duration-150"
            title="Create Space"
          >
            <Icon icon="basil:add-solid" color="white" font-size="2em" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createSpace}>
          <input
            bind:value={newSpaceName}
            placeholder="Name"
            class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
          />
          <Button.Root
            class={`px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 ${loginLoading ? "contrast-50" : "hover:scale-[102%]"}`}
          >
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Space
          </Button.Root>
        </form>
      </Dialog>

      <!-- <Button.Root
        class="hover:scale-105 active:scale-95 transition-all duration-150"
      >
        <Icon icon="basil:settings-alt-solid" color="white" class="text-2xl" />
      </Button.Root> -->

      <Dialog title="Delete Data">
        {#snippet dialogTrigger()}
          <Button.Root
            class="hover:scale-105 active:scale-95 transition-all duration-150"
          >
            <Icon icon="ri:alarm-warning-fill" color="white" class="text-2xl" />
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
            class={`flex items-center gap-3  px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150 ${
              deleteLoading ? "contrast-50" : "hover:scale-[102%]"
            }`}
            disabled={deleteLoading}
          >
            Delete Local Data {#if deleteLoading}<Icon
                icon="ri:loader-4-fill"
                class="animate-spin"
              />{/if}
          </Button.Root>
          <Button.Root
            onclick={() => deleteData("all")}
            class={`flex items-center gap-3 px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150 ${
              deleteLoading ? "contrast-50" : "hover:scale-[102%]"
            }`}
            disabled={deleteLoading}
          >
            Delete Local and PDS Data {#if deleteLoading}<Icon
                icon="ri:loader-4-fill"
                class="animate-spin"
              />{/if}
          </Button.Root>
        </div>
      </Dialog>

      {#if dev}
        <Button.Root
          onclick={() => goto("/dev")}
          class="hover:scale-105 active:scale-95 transition-all duration-150"
        >
          <Icon
            icon="fluent:window-dev-tools-16-regular"
            color="white"
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
            class="hover:scale-105 active:scale-95 transition-all duration-150"
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
              class="px-4 py-2 bg-white text-black rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
            >
              Logout
            </Button.Root>
          </section>
        {:else}
          <form class="flex flex-col gap-4" onsubmit={login}>
            {#if loginError}
              <p class="text-red-500">{loginError}</p>
            {/if}
            <input
              bind:value={handleInput}
              placeholder="Handle (eg alice.bsky.social)"
              class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
            />
            <Button.Root
              class={`px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 ${loginLoading ? "contrast-50" : "hover:scale-[102%]"}`}
            >
              Login with Bluesky
              {#if loginLoading}<Icon
                  icon="ri:loader-4-fill"
                  class="animate-spin"
                />{/if}
            </Button.Root>
          </form>
        {/if}
      </Dialog>
    </section>
  </aside>

  {@render children()}
</div>