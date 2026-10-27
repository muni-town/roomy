<script lang="ts">
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import { parseRichTextContent } from "../../../../utils/message-body.js";
  import { enrichInternalLinks } from "./enrich-internal-links.js";
  import BlocksRenderer from "./BlocksRenderer.svelte";
  import MessageTiles from "./tiles/MessageTiles.svelte";
  import type { TileSurface } from "./tiles/tile-activity.js";
  import { RICHTEXT_MIME } from "@roomy-space/sdk";

  let {
    content,
    mimeType,
    tiles = true,
    surface = "chat",
  }: {
    /** Message content to render. Markdown for legacy messages, base64-encoded
     *  richtext JSON for `application/vnd.roomy.richtext+json` messages. */
    content: string;
    /** MIME type of the content blob. Absent → legacy markdown path. */
    mimeType?: string;
    /**
     * Whether to resolve the tile addresses in the body. Off for surfaces that
     * render a message as a *preview* of itself — the activity feed's capped,
     * masked context strip — where a tile would be a card wedged into a
     * one-line-high window. Those surfaces already render the body as plain
     * text for the same reason.
     */
    tiles?: boolean;
    /** The surface rendering the message, handed down to the tiles in it. */
    surface?: TileSurface;
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

<!-- Tiles the body addresses. Outside the block/markdown branch above because
     an address is read the same way in either: from the text the body shows.
     Inside `.prose` (both branches render there), so `not-prose` on the tile's
     own wrapper is what keeps the typography plugin off it. -->
{#if tiles}
  <MessageTiles {content} {mimeType} {surface} />
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