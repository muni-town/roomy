<script lang="ts">
  import "../../app.css";
  import Icon from "@iconify/svelte";
  import { AvatarBeam, AvatarPixel } from "svelte-boring-avatars";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Avatar, Button, ToggleGroup } from "bits-ui";
  import { onMount, setContext } from "svelte";
  import { user } from "$lib/user.svelte";
  import { encodeBase32 } from "$lib/base32";
  import { goto } from "$app/navigation";
  import { RoomyPdsStorageAdapter } from "$lib/autodoc-storage";
  import { page } from "$app/state";
  import { Toaster } from "svelte-french-toast";
  import { cleanHandle } from "$lib/utils";
  import { dev } from "$app/environment";
  import { g } from "$lib/global.svelte";
  import { ulid } from "ulidx";

  let { children } = $props();

  let loginLoading = $state(false);
  let handleInput = $state("");
  let isNewSpaceDialogOpen = $state(false);
  let newSpaceName = $state("");
  let isLoginDialogOpen = $state(!user.session);
  let deleteLoading = $state(false);

  // TODO: set servers/rooms based on user
  let servers: string[] = $derived(
    g.catalog?.view.spaces.map((x) => x.id) || [],
  );
  let currentCatalog = $state("");

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
      g.spaces[id].change((doc) => (doc.name = newSpaceName));
      newSpaceName = "";
    }, 0);
    isNewSpaceDialogOpen = false;
  }

  async function deleteData(kind: "all" | "local") {
    deleteLoading = true;

    if (kind == "all") {
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
</script>

<svelte:head>
  <title>Roomy</title>
</svelte:head>

<!-- Container -->
<div class="relative flex gap-4 p-4 bg-violet-900 w-screen h-screen">
  <Toaster />
  <!-- Server Bar -->
  <aside
    class="flex flex-col justify-between w-20 h-full bg-violet-950 rounded-lg px-4 py-8 items-center"
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
          <!-- TODO: set images based on server -->
          <Avatar.Image />
          <Avatar.Fallback>
            <Icon icon="ri:user-fill" font-size="2em" />
          </Avatar.Fallback>
        </Avatar.Root>
      </ToggleGroup.Item>

      <div class="border-white border-t-1 w-[80%]"></div>

      {#each servers as server}
        <ToggleGroup.Item
          onclick={() => goto(`/space/${server}`)}
          value={server}
          title={g.spaces[server].view.name}
          class="capitalize hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white p-4 rounded-md"
        >
          <Avatar.Root>
            <!-- TODO: set images based on server -->
            <Avatar.Image />
            <Avatar.Fallback>
              <AvatarPixel name={server} />
            </Avatar.Fallback>
          </Avatar.Root>
        </ToggleGroup.Item>
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
            <strong>Warning:</strong> This will delete the Roomy data from this
            device and from your AtProto PDS if you chose.
          </p>
          <p class="text-sm">
            Roomy is currently <em>extremely</em> experimental, so until it gets
            a little more stable it may be necessary to reset all of your data
            in order to fix a problem after an update of Roomy is published.
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
        title="Login with AT Protocol"
        bind:isDialogOpen={isLoginDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            class="hover:scale-105 active:scale-95 transition-all duration-150"
          >
            <Avatar.Root>
              <Avatar.Image
                src={user.profile.data?.avatar}
                class="rounded-full"
              />
              <Avatar.Fallback>
                <AvatarBeam name="pigeon" />
              </Avatar.Fallback>
            </Avatar.Root>
          </Button.Root>
        {/snippet}

        {#if user.session}
          <section class="flex flex-col gap-4">
            <p>Logged in as {user.profile.data?.handle}</p>
            {#if user.keypair.value}
              <p>
                <strong>PublicKey: </strong>
                {encodeBase32(
                  user.keypair.value?.publicKey || new Uint8Array(),
                )}
              </p>
            {/if}
            <Button.Root
              onclick={user.logout}
              class="px-4 py-2 bg-white text-black rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
            >
              Logout
            </Button.Root>
          </section>
        {:else}
          <form
            class="flex flex-col gap-4"
            onsubmit={async () => {
              loginLoading = true;
              handleInput = cleanHandle(handleInput);
              await user.loginWithHandle(handleInput);
            }}
          >
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