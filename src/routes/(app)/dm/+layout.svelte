<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Avatar, Button, ToggleGroup } from "bits-ui";

  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { onMount } from "svelte";
  import { cleanHandle, unreadCount } from "$lib/utils";
  import { RichText } from "@atproto/api";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  let { children } = $props();

  let dms = $derived(
    Object.entries(g.catalog?.view.dms || {}).map(([did, dm]) => ({
      did,
      ...dm,
      unreadCount: g.dms[did]
        ? unreadCount(g.dms[did].view, dm.viewedHeads || [])
        : 0,
    })),
  );

  let currentDm = $state("");

  let newDmDialogOpen = $state(false);
  let sendBlueSkyDMInvite = $state(false);
  let newDmInput = $state("");
  let newDmLoading = $state(false);
  let newDmError = $state(undefined) as undefined | string;

  let width: number = $state(0);
  let isMobile = $derived(width < 640);


  onMount(() => {
    if (page.params.did) {
      currentDm = page.params.did;
    }
  });

  async function createDm() {
    if (newDmLoading) return;
    newDmError = undefined;
    newDmLoading = true;

    newDmInput = cleanHandle(newDmInput);

    try {
      const resp = await user.agent!.resolveHandle({ handle: newDmInput });
      if (!resp.success) {
        throw "Could not resolve";
      }

      const profile = await user.agent!.getProfile({ actor: newDmInput });

      if (sendBlueSkyDMInvite && user.agent) {
        const inviteUrl = `${page.url.protocol}//${page.url.host}/dm/${user.agent.assertDid}`;
        const headers = {
          headers: {
            "atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
          },
        };
        const convoResp = await user.agent.chat.bsky.convo.getConvoForMembers(
          {
            members: [user.agent.assertDid, resp.data.did],
          },
          headers,
        );
        if (!convoResp.success)
          throw new Error("Could not get bsky chat for sending invite");
        const { convo } = convoResp.data;
        const rt = new RichText({
          text: `Invite to Roomy chatroom: ${inviteUrl}`,
        });
        rt.detectFacets(user.agent);

        user.agent.chat.bsky.convo.sendMessage(
          {
            convoId: convo.id,
            message: {
              text: rt.text,
              facets: rt.facets,
            },
          },
          headers,
        );
      }

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
      newDmError = (e as Error).message;
    } finally {
      newDmLoading = false;
    }
  }
</script>

<svelte:window bind:outerWidth={width} />

<!-- Room Selector; TODO: Sub Menu (eg Settings) -->
<nav class={`flex flex-col gap-4 h-full ${isMobile ? "w-full px-2 py-4" : "w-72 p-4"} bg-violet-950 rounded-lg`}>
  <h1 class="text-2xl font-extrabold text-white px-2 py-1 flex items-center justify-between">
    Direct Messages
  </h1>

  <hr />

  <Dialog title="New Direct Message" bind:isDialogOpen={newDmDialogOpen}>
    {#snippet dialogTrigger()}
      <Button.Root
        class="bg-white w-full h-fit font-medium px-4 py-2 flex gap-2 items-center justify-center rounded-lg hover:scale-105 active:scale-95 transition-all duration-150"
      >
        <Icon icon="ri:add-fill" class="text-lg" />
        Create DM
      </Button.Root>
    {/snippet}

    {#if newDmError}
      <p class="text-red-500">{newDmError}</p>
    {/if}

    <form class="flex flex-col gap-4 w-full" onsubmit={createDm}>
      <input
        bind:value={newDmInput}
        placeholder="Handle (eg alice.bsky.social)"
        class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
      />
      <label class="flex gap-4 items-center justify-start w-full">
        <input
          type="checkbox"
          bind:checked={sendBlueSkyDMInvite}
          placeholder="Handle (eg alice.bsky.social)"
          class=""
        />

        Send BlueSky DM With Invite Link
      </label>
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
  </Dialog>

  <!-- Channels -->
  <ToggleGroup.Root
    value={currentDm}
    type="single"
    class="flex flex-col gap-4 items-center"
  >
    {#each dms as dm}
      <ToggleGroup.Item
        value={dm.did}
        onclick={() => {
          goto(`/dm/${dm.did || ""}`);
        }}
        class={`${(g.routerConnections[dm.did] || []).length > 0 ? "online" : ""} flex gap-4 items-center w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md`}
      >
        <AvatarImage avatarUrl={dm.avatar} handle={dm.name} />
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
{#if !isMobile}
  <main class="flex flex-col gap-4 bg-violet-950 rounded-lg p-4 grow">
    {@render children()}
  </main>
{:else if page.params.did}
  <main class="absolute inset-0 flex flex-col gap-4 bg-violet-950 rounded-lg p-4">
    {@render children()}
  </main>
{/if}

<style>
  :global(.online img) {
    box-shadow: greenyellow 0px 0px 7px 3px;
  }
</style>