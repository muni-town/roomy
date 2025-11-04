<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Button, Prose } from "@fuxui/base";
  import ScrollArea from "$lib/components/layout/ScrollArea.svelte";
  import { RichTextEditor } from "@fuxui/text";
  import { patchMake, patchToText } from "diff-match-patch-es";
  import Turndown from "turndown";
  import { ulid } from "ulidx";
  import { scrollContainerRef } from "$lib/utils.svelte";

  import IconTablerCheck from "~icons/tabler/check";
  import IconTablerPencil from "~icons/tabler/pencil";
  import TimelineView from "../thread/TimelineView.svelte";

  let isEditing = $state(false);

  let { showPageChat = $bindable(false) } = $props();

  let pageQuery = new LiveQuery<{ content: string }>(
    () => sql`
    select cast(data as text) as content
    from comp_content
    where
      entity = ${page.params.object && id(page.params.object)}
    `,
  );
  let pageContent = $derived(pageQuery.result?.[0]?.content);
  let editingContent = $state("");

  async function savePage() {
    if (!current.space?.id || !page.params.object) return;

    isEditing = false;
    const newMarkdown = new Turndown().turndown(editingContent);
    if (pageContent == newMarkdown) return;
    const patch = patchToText(patchMake(pageContent || "", newMarkdown));
    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: page.params.object,
      variant: {
        kind: "space.roomy.page.edit.0",
        data: {
          content: {
            mimeType: "text/x-dmp-patch",
            content: new TextEncoder().encode(patch),
          },
        },
      },
    });
  }

  let ref: HTMLDivElement | null = $state(null);

  // Sync the ref to the store
  $effect(() => {
    console.log("Setting scroll container ref", ref);
    scrollContainerRef.set(ref);
  });
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
        {#if isEditing}
          <RichTextEditor
            content={editingContent}
            onupdate={(_c, ctx) => {
              editingContent = ctx.editor.getHTML();
            }}
          />
        {:else if pageContent}
          {@html renderMarkdownSanitized(pageContent)}
        {:else}
          Loading...
        {/if}
      </Prose>
    </div>
  </ScrollArea>
  {#if showPageChat}
    <div
      class="max-w-lg mr-2 w-full border border-base-200 rounded-xl justify-self-end"
    >
      <TimelineView />
    </div>
  {/if}
</div>
