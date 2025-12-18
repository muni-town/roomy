<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { renderMarkdownSanitized } from "$lib/utils/markdown";
  import { current } from "$lib/queries";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend } from "$lib/workers";
  import { Button, Prose } from "@fuxui/base";
  import ScrollArea from "$lib/components/layout/ScrollArea.svelte";
  import { RichTextEditor } from "$lib/components/richtext";
  import { patchMake, patchToText } from "diff-match-patch-es";
  import Turndown from "turndown";
  import { newUlid, toBytes, ulid } from "$lib/schema";
  import { scrollContainerRef } from "$lib/utils.svelte";

  import IconTablerCheck from "~icons/tabler/check";
  import IconTablerPencil from "~icons/tabler/pencil";
  import TimelineView, {
    messagingState,
    type Comment,
  } from "../thread/TimelineView.svelte";
  import { ensureShowPageChat } from "$lib/../routes/(app)/[space=hashOrDomain]/[object=ulid]/+page.svelte";

  let isEditing = $state(false);
  const spaceId = $derived(current.joinedSpace?.id);

  let { showPageChat = $bindable(false) } = $props();

  let pageQuery = new LiveQuery<{ content: string; latestEditId: string }>(
    () => sql`
    select 
      cast(data as text) as content,
      (
        select id(edit_id)
        from comp_page_edits
        where entity = ${page.params.object}
        order by edit_id desc
        limit 1
      ) as latestEditId
    from comp_content
    where
      entity = ${page.params.object}
    `,
  );
  let pageMarkdown = $derived(pageQuery.result?.[0]?.content);
  let latestEditId = $derived(pageQuery.result?.[0]?.latestEditId);
  let savedHtml = $derived(renderMarkdownSanitized(pageMarkdown || ""));
  let editedHtml = $state("");

  async function savePage() {
    if (!spaceId || !page.params.object) return;

    isEditing = false;
    const newMarkdown = new Turndown().turndown(editedHtml);
    if (pageMarkdown == newMarkdown) return;
    const patch = patchToText(patchMake(pageMarkdown || "", newMarkdown));
    await backend.sendEvent(spaceId, {
      id: newUlid(),
      room: ulid.assert(page.params.object),
      variant: {
        $type: "space.roomy.page.edit.v0",
        content: {
          mimeType: "text/x-dmp-patch",
          content: toBytes(new TextEncoder().encode(patch)),
        },
      },
    });
  }

  let ref: HTMLDivElement | null = $state(null);

  // Sync the ref to the store
  $effect(() => {
    scrollContainerRef.set(ref);
  });

  function setComment(selectedText: string, from: number, to: number) {
    // Ensure the chat is visible
    ensureShowPageChat();

    if (selectedText.length) {
      // Create the comment with the selected text and latest edit ID
      const comment: Comment = {
        snippet: selectedText.slice(0, 200), // limit to 200 chars
        docVersion: latestEditId || "",
        from,
        to,
      };

      messagingState.setCommenting(comment);
    } else {
      // If no text is selected, revert to normal mode
      messagingState.setNormal();
    }
  }
</script>

<div class="flex h-full gap-1 py-4 px-1">
  <ScrollArea
    orientation="vertical"
    class={["relative grow w-full", showPageChat ? "" : ""]}
    bind:ref
  >
    <div class="flex z-10 justify-end mb-4 sticky top-0 pr-3">
      {#if isEditing}
        <Button onclick={savePage}>
          <IconTablerCheck />
          Save
        </Button>
      {:else}
        <Button
          variant="secondary"
          disabled={!pageQuery.result?.length}
          onclick={() => {
            isEditing = true;
          }}
        >
          <IconTablerPencil />
          Edit
        </Button>
      {/if}
    </div>
    <div class="max-w-2xl mx-auto w-full px-4 pb-8">
      <Prose>
        {#if savedHtml}
          <!--
          This key block will make sure that the text editor is recrated whenever the page changes.
          This fixes an issue where merely updating the rendered HTML returned by the new page query
          is not actually updating the rich text area.
          -->
          {#key savedHtml}
            <RichTextEditor
              content={savedHtml}
              bind:editable={isEditing}
              onupdate={(_c, ctx) => {
                editedHtml = ctx.editor.getHTML();
              }}
              oncomment={setComment}
            />
          {/key}
        {:else}
          Loading...
        {/if}
      </Prose>
    </div>
  </ScrollArea>
  {#if showPageChat}
    <div
      class="max-w-lg mr-2 w-full border border-base-200 dark:border-base-800 rounded-xl justify-self-end"
    >
      <TimelineView />
    </div>
  {/if}
</div>
