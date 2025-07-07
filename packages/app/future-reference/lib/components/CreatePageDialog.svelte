<script lang="ts">
  import { toast } from "svelte-french-toast";
  import Dialog from "../../../src/lib/components/Dialog.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { Channel, Space, createPage, createPagesList } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";

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

  let {
    triggerStyle = "dz-btn dz-btn-primary dz-btn-sm text-lg",
  }: {
    triggerStyle?: string;
  } = $props();

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

{#if channel.current && space.current}
  <button class={triggerStyle} onclick={createPageDialog}> + </button>
{/if}
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
