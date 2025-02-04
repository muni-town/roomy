<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Avatar, Button, Dialog, Separator, ToggleGroup } from "bits-ui";

  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { fade } from "svelte/transition";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { onMount } from "svelte";
  import { unreadCount } from "$lib/utils";

  let { children } = $props();

  let dms = $derived(
    Object.entries(g.catalog?.view.dms || {}).map(([did, dm]) => ({
      did,
      ...dm,
      unreadCount: unreadCount(g.dms[did].view, dm.viewedHeads || []),
    })),
  );

  let currentDm = $state("");

  let newDmDialogOpen = $state(false);
  let newDmInput = $state("");
  let newDmLoading = $state(false);
  let newDmError = $state(undefined) as undefined | string;

  onMount(() => {
    if (page.params.did) {
      currentDm = page.params.did;
    }
  });

  async function createDm() {
    if (newDmLoading) return;
    newDmError = undefined;
    newDmLoading = true;
    try {
      const resp = await user.agent!.resolveHandle({ handle: newDmInput });
      if (!resp.success) {
        throw "Could not resolve";
      }

      const profile = await user.agent!.getProfile({ actor: newDmInput });

      g.catalog?.change((doc) => {
        doc.dms[resp.data.did] = {
          name: newDmInput,
          avatar: profile.data.avatar,
          viewedHeads: [],
        };
      });

      newDmDialogOpen = false;
      newDmInput = "";
    } catch (e) {
      newDmError = `Could not find account with handle: @${newDmInput}`;
    } finally {
      newDmLoading = false;
    }
  }
</script>

<!-- Room Selector; TODO: Sub Menu (eg Settings) -->
<nav class="flex flex-col gap-4 p-4 h-full w-72 bg-violet-950 rounded-lg">
  <h1
    class="text-2xl font-extrabold text-white px-2 py-1 text-ellipsis flex items-center justify-between"
  >
    Direct Messages
  </h1>

  <hr />

  <Dialog.Root bind:open={newDmDialogOpen}>
    <Dialog.Trigger>
      <Button.Root
        class="bg-white w-full h-fit font-medium px-4 py-2 flex gap-2 items-center justify-center rounded-lg hover:scale-105 active:scale-95 transition-all duration-150"
      >
        <Icon icon="ri:add-fill" class="text-lg" />
        Create DM
      </Button.Root>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay
        transition={fade}
        transitionConfig={{ duration: 150 }}
        class="fixed inset-0 z-50 bg-black/80"
      />
      <Dialog.Content
        class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
      >
        <Dialog.Title class="text-bold font-bold text-xl">
          New Direct Message
        </Dialog.Title>
        <Separator.Root class="border border-white" />

        {#if newDmError}
          <Dialog.Description>
            <div class="text-red-500">
              {newDmError}
            </div>
          </Dialog.Description>
        {/if}

        <form class="flex flex-col gap-4" onsubmit={createDm}>
          <input
            bind:value={newDmInput}
            placeholder="Handle (eg alice.bsky.social)"
            class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
          />
          <Button.Root
            disabled={!newDmInput}
            class={`px-4 py-2 bg-white text-black rounded-lg disabled:bg-white/50 active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 ${newDmLoading ? "contrast-50" : "hover:scale-[102%]"}`}
          >
            Open Direct Message
            {#if newDmLoading}
              {" "}
              <Icon icon="ri:loader-4-fill" class="animate-spin" />
            {/if}
          </Button.Root>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>

  <!-- Channels -->
  <ToggleGroup.Root
    value={currentDm}
    type="single"
    class="flex flex-col gap-4 items-center"
  >
    {#each dms as dm}
      <ToggleGroup.Item
        onclick={() => {
          goto(`/dm/${dm.did || ""}`);
        }}
        value={dm.did}
        class={`${(g.routerConnections[dm.did] || []).length > 0 ? "online" : ""} flex gap-4 items-center w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md`}
      >
        <Avatar.Root class="w-8">
          <Avatar.Image src={dm.avatar} class="rounded-full" />
          <Avatar.Fallback>
            <AvatarBeam name={dm.name} />
          </Avatar.Fallback>
        </Avatar.Root>
        <h3>{dm.name}</h3>
        {#if dm.unreadCount > 0}
          <span class="bg-red-500 text-white px-2 py-1 rounded-full">
            {dm.unreadCount}
          </span>
        {/if}
      </ToggleGroup.Item>
    {/each}
  </ToggleGroup.Root>
</nav>

<!-- Events/Room Content -->
<main class="grow flex flex-col gap-4 bg-violet-950 rounded-lg p-4">
  {@render children()}
</main>

<style>
  :global(.online img) {
    box-shadow: greenyellow 0px 0px 7px 3px;
  }
</style>
