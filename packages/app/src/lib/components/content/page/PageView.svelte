<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Button, Prose, ScrollArea } from "@fuxui/base";
  import { RichTextEditor } from "@fuxui/text";
  import { patchMake, patchToText } from "diff-match-patch-es";
  import Turndown from "turndown";
  import { ulid } from "ulidx";

  import IconTablerCheck from "~icons/tabler/check";
  import IconTablerPencil from "~icons/tabler/pencil";

  let isEditing = $state(false);

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
</script>

<ScrollArea orientation="vertical">
  <div class="max-w-4xl mx-auto w-full px-4 py-8">
    <div class="flex justify-end mb-4">
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
            editingContent = pageContent
              ? renderMarkdownSanitized(pageContent)
              : "";
          }}
        >
          <IconTablerPencil />
          Edit
        </Button>
      {/if}
    </div>

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
