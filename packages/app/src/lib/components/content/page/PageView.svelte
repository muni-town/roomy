<script lang="ts">
  import { Button, Prose } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { PageContent, RoomyAccount } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import { RichTextEditor } from "@fuxui/text";

  let { objectId, spaceId: _ }: { objectId: string; spaceId: string } =
    $props();

  const page = $derived(new CoState(PageContent, objectId));

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        newJoinedSpacesTest: true,
      },
    },
  });

  let isEditing = $state(false);

  let editingContent = $state("hello");
</script>

<div class="max-w-4xl mx-auto w-full px-4 py-8">
  {#if page.current && me.current?.canWrite(page.current)}
    <div class="flex justify-end mb-4">
      {#if isEditing}
        <Button
          onclick={() => {
            isEditing = false;
            if (page.current) {
              console.log(editingContent);
              page.current.text = editingContent;
            }
          }}
        >
          <Icon icon="tabler:check" />
          Save
        </Button>
      {:else}
        <Button
          variant="secondary"
          onclick={() => {
            if (page.current) {
              editingContent = page.current.text;
            }
            isEditing = true;
          }}
        >
          <Icon icon="tabler:pencil" />
          Edit
        </Button>
      {/if}
    </div>
  {/if}

  <Prose>
    {#if isEditing}
      <RichTextEditor
        content={editingContent}
        onupdate={(_c, ctx) => {
          editingContent = ctx.editor.getHTML();
        }}
      />
    {:else}
      {@html page.current?.text || "Empty page..."}
    {/if}
  </Prose>
</div>
