<script lang="ts">
  import { toast } from "svelte-french-toast";
  import Dialog from "./Dialog.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { Channel, Space } from "$lib/jazz/schema";
  import { createPage, createPagesList } from "$lib/jazz/utils";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";

  let {
    triggerStyle = "dz-btn dz-btn-primary dz-btn-sm text-lg",
  } = $props();

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        pages: {
          $each: true,
          $onError: null,
        },
        $onError: null,
      },
    }),
  );

  let channel = $derived(
    new CoState(Channel, page.params.channel, {
      resolve: {
        pages: {
          $each: true,
          $onError: null,
        },
        $onError: null,
      },
    }),
  );

  let isPageTitleDialogOpen = $state(false);
  let newPageTitle: string = $state("");

  export function createPageDialog() {
    newPageTitle = "";
    isPageTitleDialogOpen = true;
  }

  async function submitPageTitle() {
    console.log(channel.current);
    if (!channel?.current) return;

    if (!channel.current.pages) {
      channel.current.pages = createPagesList();
    }

    if (!newPageTitle) {
      toast.error("Title cannot be empty", { position: "bottom-end" });
      return;
    }

    const pg = createPage(newPageTitle);

    isPageTitleDialogOpen = false;

    space.current?.pages?.push(pg);
    console.log("space", space.current, space.current?.pages);
    channel.current?.pages?.push(pg);
  }
</script>

<button class="dz-btn dz-btn-primary dz-btn-sm relative z-50" onclick={createPageDialog} style="margin-left: 8px;"> + </button>
<Dialog
  title="New Page"
  description="Give your new page a title"
  bind:isDialogOpen={isPageTitleDialogOpen}
>
  <form onsubmit={submitPageTitle} class="flex flex-col gap-4">
    <input
      type="text"
      bind:value={newPageTitle}
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
