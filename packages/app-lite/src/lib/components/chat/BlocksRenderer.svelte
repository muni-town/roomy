<script lang="ts">
  import type { Block, Facet, FacetFeature } from "@roomy-space/sdk";

  let {
    blocks,
  }: {
    /** Blocks+facets message body to render (new format). */
    blocks: Block[];
  } = $props();

  /**
   * Facet byte offsets are UTF-8; JS string slicing is UTF-16. Convert a
   * UTF-8 byte offset into a UTF-16 code-unit index by walking the string
   * and accumulating each code unit's UTF-8 byte length.
   */
  function utf8ToUtf16Index(s: string, byteOffset: number): number {
    const bytes = new TextEncoder().encode(s);
    if (byteOffset <= 0) return 0;
    if (byteOffset >= bytes.length) return s.length;
    let bytePos = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      bytePos += code >= 0x80 ? (code >= 0x800 ? 3 : 2) : 1;
      if (bytePos >= byteOffset) return i + 1;
    }
    return s.length;
  }

  /** Clamp a facet's byte range to the text, then convert to UTF-16 indices. */
  function facetRange(text: string, facet: Facet): [number, number] {
    const start = utf8ToUtf16Index(text, facet.index.byteStart);
    const end = utf8ToUtf16Index(text, facet.index.byteEnd);
    return [Math.min(start, end), Math.max(start, end)];
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Escape HTML and convert newlines to `<br>` (for text-bearing blocks). */
  function escapeText(s: string): string {
    return escapeHtml(s).replace(/\n/g, "<br>");
  }

  function escapeAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  /**
   * Render a text slice with its facets applied. Facets are sorted by
   * byteStart; overlapping ranges nest (later facets wrap earlier ones).
   * Unknown features fall through to plain text.
   *
   * Escaping happens per-slice: facet byte offsets are computed over the raw
   * text, so escaping the whole string first would shift them. Each plain
   * and faceted slice is escaped independently, then wrapped.
   */
  function renderFaceted(text: string, facets: Facet[] | undefined): string {
    if (!facets || facets.length === 0) return escapeText(text);
    const sorted = [...facets].sort(
      (a, b) => a.index.byteStart - b.index.byteStart,
    );
    const out: string[] = [];
    let pos = 0;
    for (const facet of sorted) {
      const [start, end] = facetRange(text, facet);
      if (end <= pos) continue; // fully consumed (nested inside an earlier facet)
      const sliceStart = Math.max(start, pos);
      if (sliceStart > pos) {
        out.push(escapeText(text.slice(pos, sliceStart)));
      }
      const slice = text.slice(sliceStart, end);
      pos = end;
      out.push(wrapFeatures(slice, facet.features));
    }
    if (pos < text.length) out.push(escapeText(text.slice(pos)));
    return out.join("");
  }

  function wrapFeatures(slice: string, features: FacetFeature[]): string {
    let inner = escapeText(slice);
    for (const feature of features) {
      switch (feature.$type) {
        case "space.roomy.richtext.facet#bold":
          inner = `<strong>${inner}</strong>`;
          break;
        case "space.roomy.richtext.facet#italic":
          inner = `<em>${inner}</em>`;
          break;
        case "space.roomy.richtext.facet#code":
          inner = `<code>${inner}</code>`;
          break;
        case "space.roomy.richtext.facet#strikethrough":
          inner = `<s>${inner}</s>`;
          break;
        case "space.roomy.richtext.facet#underline":
          inner = `<u>${inner}</u>`;
          break;
        case "space.roomy.richtext.facet#link": {
          const uri = (feature as { uri: string }).uri;
          inner = `<a href="${escapeAttr(uri)}" oncontextmenu="event.stopPropagation()" class="text-accent-600 dark:text-accent-400 no-underline hover:underline">${inner}</a>`;
          break;
        }
        case "space.roomy.richtext.facet#didMention": {
          // The slice already carries the `@` prefix (the converter folds the
          // mention node's label into the block text as `@label`).
          const did = (feature as { did: string }).did;
          inner = `<a href="/user/${escapeAttr(did)}" oncontextmenu="event.stopPropagation()" class="mention !no-underline">${inner}</a>`;
          break;
        }
        case "space.roomy.richtext.facet#roomRef": {
          const roomRef = feature as { spaceId: string; roomId?: string };
          inner = `<a href="/${escapeAttr(roomRef.spaceId)}${roomRef.roomId ? `/${escapeAttr(roomRef.roomId)}` : ""}" oncontextmenu="event.stopPropagation()" class="mention !no-underline">${inner}</a>`;
          break;
        }
        default:
          break; // unknown features → plain text
      }
    }
    return inner;
  }

  function renderText(text: string, facets: Facet[] | undefined): string {
    return renderFaceted(text, facets);
  }

  function renderListItems(
    items: { text: string; facets?: Facet[] }[],
  ): string {
    return items
      .map((item) => `<li>${renderText(item.text, item.facets)}</li>`)
      .join("");
  }

  /** Stable per-block key for the `{#each}`. */
  function blockKey(block: Block, index: number): string {
    return `${block.$type}:${index}`;
  }

  // The `Block` union includes an open catch-all (`UnknownBlock`), so
  // `$type` narrowing alone can't prove the payload fields exist. These
  // accessors cast to the known shapes after the template's `$type` check.
  function blockText(block: Block): string {
    return (block as { text?: string }).text ?? "";
  }
  function blockFacets(block: Block): Facet[] | undefined {
    return (block as { facets?: Facet[] }).facets;
  }
  function blockLevel(block: Block): number {
    return (block as { level?: number }).level ?? 1;
  }
  function blockItems(
    block: Block,
  ): { text: string; facets?: Facet[] }[] {
    return (block as { items?: { text: string; facets?: Facet[] }[] })
      .items ?? [];
  }
  function blockUri(block: Block): string {
    return (block as { uri?: string }).uri ?? "";
  }
  function blockAlt(block: Block): string | undefined {
    return (block as { alt?: string }).alt;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="roomy-blocks">
  {#each blocks as block, i (blockKey(block, i))}
    {#if block.$type === "space.roomy.richtext.blocks#text"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <p class="my-0.5 break-words">{@html renderText(blockText(block), blockFacets(block))}</p>
    {:else if block.$type === "space.roomy.richtext.blocks#header"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svelte:element this={"h" + blockLevel(block)} class="font-semibold break-words my-1">{@html renderText(blockText(block), blockFacets(block))}</svelte:element>
    {:else if block.$type === "space.roomy.richtext.blocks#blockquote"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <blockquote class="border-l-2 border-base-300 dark:border-base-600 pl-3 my-1 break-words">{@html renderText(blockText(block), blockFacets(block))}</blockquote>
    {:else if block.$type === "space.roomy.richtext.blocks#code"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <pre class="bg-base-100 dark:bg-base-800 rounded-md p-2 my-1 overflow-x-auto text-sm"><code>{@html escapeHtml(blockText(block))}</code></pre>
    {:else if block.$type === "space.roomy.richtext.blocks#orderedList"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <ol class="list-decimal pl-5 my-1 space-y-0.5">{@html renderListItems(blockItems(block))}</ol>
    {:else if block.$type === "space.roomy.richtext.blocks#unorderedList"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <ul class="list-disc pl-5 my-1 space-y-0.5">{@html renderListItems(blockItems(block))}</ul>
    {:else if block.$type === "space.roomy.richtext.blocks#image"}
      <img
        src={blockUri(block)}
        alt={blockAlt(block) ?? ""}
        class="rounded-md max-w-full my-1"
        loading="lazy"
      />
    {:else if block.$type === "space.roomy.richtext.blocks#horizontalRule"}
      <hr class="my-2 border-base-300 dark:border-base-600" />
    {/if}
  {/each}
</div>

<style>
  /*
    The wrapper host sits between `.prose` (in MessageBubble) and the rendered
    blocks, so it breaks the `.prose > :first-child` / `> :last-child` margin
    resets that Tailwind Typography applies to flush the first/last paragraph
    with the bubble. The wrapper itself is display:contents (no box), so
    re-apply those resets through it to keep message text flush — mirroring
    MessageContent.svelte's `.roomy-message-content`.
  */
  .roomy-blocks {
    display: contents;
  }
  :global(.prose > .roomy-blocks > :first-child) {
    margin-top: 0;
  }
  :global(.prose > .roomy-blocks > :last-child) {
    margin-bottom: 0;
  }
</style>
