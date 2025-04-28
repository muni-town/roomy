<script lang="ts">
  import { toast } from "svelte-french-toast";
  import { Channel, WikiPage } from "@roomy-chat/sdk";
  import { g } from "$lib/global.svelte";
  import Dialog from "./Dialog.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";

  let {
    triggerStyle = "dz-btn dz-btn-primary dz-btn-sm text-lg",
  }: {
    triggerStyle?: string;
  } = $props();

  let isWikiTitleDialogOpen = $state(false);
  let newWikiTitleElement: HTMLInputElement | null = $state(null);

  export function createWiki() {
    if (newWikiTitleElement) {
      newWikiTitleElement.value = "";
    }
    isWikiTitleDialogOpen = true;
  }

  async function submitWikiTitle() {
    if (!g.space || !g.channel || !(g.channel instanceof Channel)) return;
    if (!newWikiTitleElement) {
      toast.error("Title cannot be empty", { position: "bottom-end" });
      return;
    }
    const newWikiTitle = newWikiTitleElement.value; // Retrieve the title from the input element
    // Create a temporary wiki with the provided title
    const wiki = await g.space.create(WikiPage);

    isWikiTitleDialogOpen = false;

    try {
      wiki.name = newWikiTitle;

      g.channel.wikipages.push(wiki);
      g.channel?.commit();

      g.space.wikipages.push(wiki);
      g.space.commit();
      wiki.commit();
    } catch (e) {
      console.error("Error creating wiki", e);
      toast.error("Failed to create wiki", { position: "bottom-end" });
    }
  }
</script>

<button class={triggerStyle} onclick={createWiki}> + </button>
<Dialog
  title="New Wiki"
  description="Give your new wiki a title"
  bind:isDialogOpen={isWikiTitleDialogOpen}
>
  <form onsubmit={submitWikiTitle} class="flex flex-col gap-4">
    <input
      type="text"
      bind:this={newWikiTitleElement}
      use:focusOnRender
      placeholder="Tips on moderation..."
      class="dz-input dz-input-bordered w-full"
      required
    />
    <div class="flex justify-end gap-3 mt-2">
      <button type="submit" class="dz-btn dz-btn-primary">Create</button>
    </div>
  </form>
</Dialog>
