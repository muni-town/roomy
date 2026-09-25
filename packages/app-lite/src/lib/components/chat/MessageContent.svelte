<script lang="ts">
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import { enrichInternalLinks } from "./enrich-internal-links";
  import { parseRichTextContent } from "./message-body";
  import BlocksRenderer from "./BlocksRenderer.svelte";
  import { RICHTEXT_MIME } from "@roomy-space/sdk";

  let {
    content,
    mimeType,
  }: {
    /** Message content to render. Markdown for legacy messages, base64-encoded
     *  richtext JSON for `application/vnd.roomy.richtext+json` messages. */
    content: string;
    /** MIME type of the content blob. Absent → legacy markdown path. */
    mimeType?: string;
  } = $props();

  // New format: content is base64-encoded JSON of the blocks document
  // (the appserver's decodeContent base64-encodes non-text mimeTypes).
  // Parse once; on any failure fall back to the legacy markdown path.
  const blocks = $derived(
    mimeType === RICHTEXT_MIME ? parseRichTextContent(content) : null,
  );
</script>

{#if blocks}
  <BlocksRenderer {blocks} />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div use:enrichInternalLinks class="roomy-message-content">
    {@html renderMarkdownSanitized(content)}
  </div>
{/if}

<style>
  /*
    The wrapper host sits between `.prose` (in MessageBubble) and the rendered
    markdown. `display: contents` keeps it box-less; the shared first/last
    margin resets — which the composer's `.tiptap` needs identically — live in
    `app-lite/src/lib/message-typography.css`, applied through this class.
  */
  .roomy-message-content {
    display: contents;
  }
</style>