<script lang="ts">
  import { toast } from "svelte-french-toast";
  // import { Channel, WikiPage } from "@roomy-chat/sdk";
  import { globalState} from "$lib/global.svelte";
  import Dialog from "./Dialog.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { Channel, Page } from "$lib/jazz/schema";
  import { co } from "jazz-tools";
  import { createPage } from "$lib/jazz/utils";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";

  let channel = $derived.by(() => {
    try {
      const channel = new CoState(Channel, page.params.channel, {
        resolve: {
          pages: true
        },
      })
      console.log(channel.current)
      return channel
    } catch (e) {
      console.error(e)
      return null
    }
  })
    
    

  $inspect(channel).with(()=>{
    console.log(channel?.id)
  })

  let {
    triggerStyle = "dz-btn dz-btn-primary dz-btn-sm text-lg",
  }: {
    triggerStyle?: string;
  } = $props();

  let isPageTitleDialogOpen = $state(false);
  let newPageTitleElement: HTMLInputElement | null = $state(null);

  export function createPageDialog() {
    if (newPageTitleElement) {
      newPageTitleElement.value = "";
    }
    isPageTitleDialogOpen = true;
  }

  async function submitPageTitle() {
    if(!channel?.current) return
    if(!channel.current.pages){
      channel.current.pages = co.list(Page).create([])
    }
    if (!newPageTitleElement) {
      toast.error("Title cannot be empty", { position: "bottom-end" });
      return;
    }
    const newPageTitle = newPageTitleElement.value; // Retrieve the title from the input element
    // Create a temporary page with the provided title
    const pg = createPage(newPageTitle)

    isPageTitleDialogOpen = false;

    try {
      channel.current.pages?.push(pg)
    } catch (e) {
      console.error("Error creating page", e);
      toast.error("Failed to create page", { position: "bottom-end" });
    }
  }
</script>

<button class={triggerStyle} onclick={createPageDialog}> + </button>
<Dialog
  title="New Page"
  description="Give your new page a title"
  bind:isDialogOpen={isPageTitleDialogOpen}
>
  <form onsubmit={submitPageTitle} class="flex flex-col gap-4">
    <input
      type="text"
      bind:this={newPageTitleElement}
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
