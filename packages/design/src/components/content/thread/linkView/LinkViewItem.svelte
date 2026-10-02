<script lang="ts">
  /**
   * LinkViewItem — a single full-width link row.
   *
   * Column structure mirrors BoardViewItem: an optional leading visual column
   * (the thumbnail), a flexible text column (heading, description, mobile meta
   * row), then fixed-width trailing columns on desktop (site, open-in-new).
   * Breakpoints are container queries, so the row reflows with the view width
   * exactly like a board row.
   */
  import { IconArrowUpRight } from "../../../../icons/index";
  import type { LinkInfo } from "./types";

  let { link }: { link: LinkInfo } = $props();

  const embed = $derived(link.embed);
  const title = $derived(embed?.title);
  const description = $derived(embed?.description);
  const videoUrl = $derived(embed?.video);
  const thumbnailUrl = $derived(embed?.thumbnail);
  const imageUrl = $derived(embed?.image);
  /** The still used wherever the row shows a picture (poster for videos). */
  const stillUrl = $derived(imageUrl ?? thumbnailUrl);
  /** Any visual to show — a video, or an image/thumbnail like LinkCard's fallback. */
  const mediaUrl = $derived(videoUrl ?? stillUrl);

  /** Hostname, shown as the heading fallback and in the meta line. */
  const hostname = $derived(
    (() => {
      try {
        return new URL(link.url).hostname;
      } catch {
        return link.url;
      }
    })(),
  );

  /** Primary heading; falls back to the hostname when the enricher found nothing. */
  const heading = $derived(title ?? hostname);
  /** oEmbed provider — author, matching the message-link card's sub-line. */
  const subtitle = $derived(
    [embed?.provider, embed?.author].filter(Boolean).join(" — "),
  );
  /**
   * Desktop site column: the provider/author when known, else the hostname —
   * but only when the heading isn't already the hostname (no title found), so
   * the row never shows the same string twice.
   */
  const siteCell = $derived(subtitle || (title ? hostname : ""));
  /** Mobile meta line: hostname then provider, hostname omitted when it's the heading. */
  const meta = $derived(
    [title ? hostname : null, subtitle].filter(Boolean).join(" · "),
  );
</script>

<a
  href={link.url}
  target="_blank"
  rel="noopener noreferrer"
  class="group flex flex-row items-stretch border-b border-base-200/70 dark:border-base-800/70 transition-colors hover:bg-base-50 dark:hover:bg-base-800/30"
>
  <!-- Thumbnail column (desktop only) -->
  {#if mediaUrl}
    <div class="hidden @[40rem]:flex w-36 shrink-0 items-center py-2.5 pl-4">
      <div
        class="relative aspect-video w-full overflow-hidden rounded-md border border-base-200 dark:border-base-800 bg-base-100 dark:bg-base-900"
      >
        {#if videoUrl}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            muted
            preload="metadata"
            class="h-full w-full object-cover"
            poster={thumbnailUrl}
            src={videoUrl}
          ></video>
        {:else if stillUrl}
          <img alt="" class="h-full w-full object-cover" src={stillUrl} />
        {/if}
      </div>
    </div>
  {/if}

  <div class="flex flex-row items-center gap-3 py-3 pl-4 sm:pl-3 pr-3 flex-1 min-w-0">
    <!-- Text column: heading + description + mobile meta row -->
    <div class="flex flex-col flex-1 min-w-0">
      <div
        class="flex-1 min-w-0 flex items-baseline gap-2 text-base font-light text-base-900 dark:text-base-100"
      >
        <span class="font-normal truncate">{heading}</span>
      </div>

      {#if description}
        <div
          class="min-w-0 truncate text-xs text-base-500 dark:text-base-400 mt-0.5"
        >
          {description}
        </div>
      {/if}

      <!-- Mobile meta row: hostname + provider (hidden on desktop) -->
      {#if meta}
        <div
          class="flex @[40rem]:hidden items-center gap-2 text-xs mt-0.5 text-base-400 dark:text-base-500"
        >
          <span class="truncate">{meta}</span>
        </div>
      {/if}
    </div>

    <!-- Mobile thumbnail (vertically centered, hidden on desktop) -->
    {#if stillUrl}
      <div class="flex items-center shrink-0 @[40rem]:hidden">
        <div
          class="relative size-12 overflow-hidden rounded-md border border-base-200 dark:border-base-800 bg-base-100 dark:bg-base-900"
        >
          <img alt="" class="h-full w-full object-cover" src={stillUrl} />
        </div>
      </div>
    {/if}

    <!-- Desktop site column (hidden on mobile) -->
    <div
      class="hidden @[40rem]:flex w-[5.5rem] shrink-0 text-sm items-center overflow-hidden text-base-500 dark:text-base-500"
    >
      <span class="min-w-0 truncate whitespace-nowrap">{siteCell}</span>
    </div>

    <!-- Desktop open-in-new column (hidden on mobile) -->
    <div
      class="hidden @[40rem]:flex w-[4.5rem] shrink-0 items-center justify-start text-base-400 dark:text-base-600"
    >
      <IconArrowUpRight
        class="size-4 transition-colors group-hover:text-accent-600 dark:group-hover:text-accent-400"
      />
    </div>
  </div>
</a>
