<!--
  The Web Tiles a message body spells out.

  A tile reaches a message by being written into it: the author drops the
  tile's AT-URI into the composer and the body carries that string. There is
  nothing to attach and no schema to change — the body is ordinary text, and
  the addresses in it are resolved here, beside the text, the way a link card
  is resolved beside the link that produced it.

  Nothing renders in the composer as the address is typed. Half an address is
  a well-formed address (`at://did:plc:…/ing.dasl.masl/3`), so a live preview
  would try to load a record that does not exist yet and settle on an error
  card for every keystroke of the last one. The message is where the address
  is final.

  Code is skipped: an address quoted inside a code block is a sample, not a
  tile (see `./message-tiles.ts`).
-->
<script lang="ts">
  import { RICHTEXT_MIME } from "@roomy-space/sdk";
  import { parseRichTextContent } from "../../../../../utils/message-body.js";
  import {
    MAX_TILES_PER_MESSAGE,
    tileAddressesInBlocks,
    tileAddressesInMarkdown,
  } from "./message-tiles.js";
  import TileEmbed from "./TileEmbed.svelte";
  import type { TileSurface } from "./tile-activity.js";

  let {
    content,
    mimeType,
    surface = "chat",
  }: {
    /** Message content to scan. Markdown for legacy messages, base64-encoded
     *  richtext JSON for `application/vnd.roomy.richtext+json` messages. */
    content: string;
    /** MIME type of the content blob. Absent → legacy markdown path. */
    mimeType?: string;
    /** The surface rendering the message, handed to each tile it resolves. */
    surface?: TileSurface;
  } = $props();
  const addresses = $derived(
    mimeType === RICHTEXT_MIME
      ? tileAddressesInBlocks(parseRichTextContent(content) ?? [])
      : tileAddressesInMarkdown(content),
  );
</script>

{#if addresses.length > 0}
  <div class="flex flex-col">
    {#each addresses.slice(0, MAX_TILES_PER_MESSAGE) as uri (uri)}
      <TileEmbed {uri} {surface} />
    {/each}
  </div>
{/if}
