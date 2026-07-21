<script lang="ts">
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import { enrichInternalLinks } from "./enrich-internal-links";

  let {
    content,
  }: {
    /** Markdown message content to render with internal link badges. */
      content: string;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div use:enrichInternalLinks class="roomy-message-content">
  {@html renderMarkdownSanitized(content)}
</div>

<style>
  /*
    The wrapper host sits between `.prose` (in MessageBubble) and the rendered
    markdown, so it breaks the `.prose > :first-child` / `> :last-child` margin
    resets that Tailwind Typography applies to flush the first/last paragraph
    with the bubble. The wrapper itself is display:contents (no box), so
    re-apply those resets through it to keep message text flush.
  */
  .roomy-message-content {
    display: contents;
  }
  :global(.prose > .roomy-message-content > :first-child) {
    margin-top: 0;
  }
  :global(.prose > .roomy-message-content > :last-child) {
    margin-bottom: 0;
  }
</style>