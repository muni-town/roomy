<script lang="ts">
  /**
   * LinkCard — renders a link's card from enriched embed data.
   *
   * The `embed` prop is the LinkEmbedData object returned by the appserver's
   * embed enricher. Two kinds of card come out of it:
   *
   *   - a Web Tile, when the appserver resolved one for the URL
   *     (`embed.tile`): the record the content type maps to, loaded and drawn
   *     by `TileEmbed` — sandboxed, no fetch from inside the tile;
   *   - otherwise the OpenGraph/oEmbed card (`embed.t` and friends).
   *
   * A tile wins because it is a renderer of the record itself; the OpenGraph
   * fields may be absent entirely for a URL whose origin refuses scrapers, and
   * the tile is then the only thing the card has. Every surface that draws a
   * link gets the tile through this component, so no surface has to know.
   *
   * When embed data is still pending or unavailable, only the URL is shown.
   *
   * When `onRemove` is provided (author's own message), a dismiss button is
   * shown so the embed preview can be removed.
   */

  import type { schemas } from "@roomy-space/sdk";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconX } from "@roomy/design/icons";
  import TileEmbed from "../tiles/TileEmbed.svelte";
  import type { TileSurface } from "../tiles/tile-activity.js";
  import { chooseLinkCard } from "./link-card.js";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

  let {
    embed,
    url,
    onRemove,
    tile = true,
    surface = "chat",
  }: {
    embed: LinkEmbedData | null | undefined;
    url: string;
    onRemove?: () => void;
    /**
     * Whether this card may render the tile its embed carries. A message
     * renders a bounded number of tiles across its body and its links (see
     * `planMessageTiles`), so the message decides and a lone card in a list
     * leaves this on.
     */
    tile?: boolean;
    /** The surface rendering the card, handed to the tile it mounts. */
    surface?: TileSurface;
  } = $props();

  /**
   * A tile that tried to load and did not: the publisher's PDS, the loading
   * server or the manifest was unreachable. The OpenGraph card the same embed
   * carries is what the reader gets instead of an error box.
   */
  let tileFailed = $state(false);

  /** Which card this link draws. See `./link-card.ts` for the rule. */
  const card = $derived(
    chooseLinkCard(embed, { tileAllowed: tile, tileFailed }),
  );

  const providerName = $derived(embed?.p?.n);
  const authorName = $derived(embed?.au?.n);
  const title = $derived(embed?.t);
  const description = $derived(embed?.d);
  const footerText = $derived(embed?.footer?.t);
  const imageUrl = $derived(
    embed?.imgs && embed.imgs.length > 0 ? embed.imgs[0]?.u : embed?.thumb?.u,
  );
  const videoUrl = $derived(embed?.vid?.u);
  const thumbnailUrl = $derived(embed?.thumb?.u);

  const subtitle = $derived(
    [providerName, authorName].filter(Boolean).join(" — "),
  );

  /** Whether any embed metadata is present to render a rich card. */
  const hasEmbedData = $derived(card.hasMetadata);

  /** Hostname shown as a plain link when there's no embed metadata. */
  const hostname = $derived((() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })());
</script>

{#snippet dismiss()}
  {#if onRemove}
    <div class="absolute right-2 top-2 z-10">
      <Button
        variant="secondary"
        size="icon"
        class="h-6 w-6 rounded-full opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100"
        aria-label="Remove embed preview"
        title="Remove embed preview"
        onclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
      >
        <IconX class="h-3 w-3" />
      </Button>
    </div>
  {/if}
{/snippet}

{#if card.tile}
<div class="group/card relative not-prose max-w-[70ch]">
  {@render dismiss()}
  <TileEmbed
    uri={card.tile.url}
    data={card.tile.data}
    {surface}
    onerror={() => (tileFailed = true)}
  />
</div>
{:else if hasEmbedData}
<div class="group/card relative not-prose max-w-[70ch]">
  {@render dismiss()}
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    class="flex flex-col justify-stretch gap-4 rounded-lg border border-base-400/60 dark:border-base-800 bg-base-100/50 dark:bg-base-900/50 min-[500px]:flex-row hover:border-accent-400/60 dark:hover:border-accent-800 hover:bg-accent-50/40 dark:hover:bg-accent-900/20 transition-colors no-underline overflow-hidden"
  >
    {#if videoUrl}
      <div class="w-full flex-shrink-0 max-h-40 overflow-hidden min-[500px]:max-w-60 min-[500px]:self-stretch">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          muted
          class="my-0 h-full w-full object-cover"
          poster={thumbnailUrl}
          src={videoUrl}
        >
        </video>
      </div>
    {:else if imageUrl}
      <div class="w-full flex-shrink-0 max-h-40 overflow-hidden min-[500px]:max-w-60 min-[500px]:self-stretch">
        <img
          alt=""
          class="m-0 h-full w-full object-cover"
          src={imageUrl}
        />
      </div>
    {/if}

    <div class="min-w-0 flex-1 px-3 py-3 flex flex-col">
      {#if subtitle}
        <p class="mb-1 mt-0 text-sm leading-none opacity-70">
          {subtitle}
        </p>
      {/if}

      {#if title}
        <p class="mb-1 mt-1 line-clamp-2 max-w-prose leading-snug text-base-900 dark:text-base-100 font-bold">
          {title}
        </p>
      {/if}

      {#if description}
        <p class="my-0 line-clamp-2 max-w-prose text-sm leading-tight text-base-500 dark:text-base-400 font-normal">
          {description}
        </p>
      {/if}

      <div class="grow py-2"></div>

      {#if footerText}
        <p class="mt-2 mb-0 text-sm">{footerText}</p>
      {/if}
    </div>
  </a>
</div>
{:else}
<div class="group/card relative not-prose max-w-[70ch]">
  {@render dismiss()}
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    class="text-sm text-primary-600 dark:text-primary-400 hover:underline no-underline truncate"
  >
    {hostname}
  </a>
</div>
{/if}
