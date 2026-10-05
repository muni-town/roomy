<script lang="ts">
  /**
   * LinkViewItem — a single link preview card in the links grid.
   *
   * The link analogue of a board row, but shaped as a card: the visuals the
   * embed already carries (`imgs` / `thumb` / `vid`) lead, because a shared
   * link is an object with a face, not a string. Column contract per card:
   * a 16:9 media band, a text well (source, title, description), and a
   * footer rule carrying the share date and the open-in-new affordance.
   *
   * Cards are passive content, so they stay flat and warm — a hairline stone
   * border, no backdrop-blur. Interaction uses the shared shadow-lift idiom
   * (DESIGN.md §4): the card rests 2px low and rises on hover/focus to reveal
   * a hard offset shadow underneath, pressing flat again on `active`. The
   * transition is the snap-fast 75ms used by `shadow-lift` and the buttons.
   * Under `prefers-reduced-motion` the transition is limited to colour, so the
   * lift still marks hover but no longer animates.
   */
  import { IconArrowUpRight, IconLink, IconPlay } from "../../../../icons/index";
  import { formatDate, formatRelativeTime } from "../../../../utils/date.js";
  import type { LinkInfo } from "./types";

  let { link }: { link: LinkInfo } = $props();

  const embed = $derived(link.embed);
  const title = $derived(embed?.title);
  const description = $derived(embed?.description);
  const videoUrl = $derived(embed?.video);
  const thumbnailUrl = $derived(embed?.thumbnail);
  const imageUrl = $derived(embed?.image);
  /** The still used wherever the card shows a picture (poster for videos). */
  const stillUrl = $derived(imageUrl ?? thumbnailUrl);
  /** Any visual to show — a video, or an image/thumbnail like LinkCard's fallback. */
  const mediaUrl = $derived(videoUrl ?? stillUrl);

  /** oEmbed provider — author, matching the message-link card's sub-line. */
  const subtitle = $derived(
    [embed?.provider, embed?.author].filter(Boolean).join(" — "),
  );

  /** Hostname, shown as the heading fallback and as the source line. */
  const hostname = $derived(
    (() => {
      try {
        return new URL(link.url).hostname.replace(/^www\./, "");
      } catch {
        return link.url;
      }
    })(),
  );

  /** Primary heading; falls back to the hostname when the enricher found nothing. */
  const heading = $derived(title ?? hostname);

  /**
   * Source line: the provider/author when known, else the hostname — but only
   * when the heading isn't already the hostname (no title found), so a card
   * never shows the same string twice.
   */
  const sourceLine = $derived(subtitle || (title ? hostname : ""));

  /**
   * Share date. Rendered relative while it is recent (that is the question a
   * reader actually has: "is this fresh?") and as an absolute date once it
   * ages past a week, matching the point where `formatRelativeTime` stops
   * being more legible than a calendar date. The full timestamp is always in
   * the `title` attribute for hover.
   */
  const sharedAt = $derived(
    (() => {
      if (!link.timestamp) return null;
      const d = new Date(link.timestamp);
      if (Number.isNaN(d.getTime())) return null;
      const ageDays = (Date.now() - d.getTime()) / 86_400_000;
      return {
        label: ageDays < 7 ? formatRelativeTime(d) : formatDate(d),
        exact: d.toLocaleString(),
      };
    })(),
  );
</script>

<a
  href={link.url}
  target="_blank"
  rel="noopener noreferrer"
  class="group relative flex flex-col overflow-hidden rounded-2xl border border-base-300/70 bg-base-100/60 translate-y-[2px] transition-all duration-75 ease-out hover:translate-y-0 hover:border-accent-400/70 hover:bg-accent-500/[0.04] hover:shadow-[0_4px_0_0_var(--shadow-button-color)] active:translate-y-[2px] active:shadow-none focus-visible:translate-y-0 focus-visible:border-accent-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-base-50 motion-reduce:transition-colors dark:border-base-800 dark:bg-base-900/40 dark:hover:border-accent-700/70 dark:hover:bg-accent-500/[0.06] dark:focus-visible:ring-offset-base-950 [--shadow-button-color:var(--color-base-300)] dark:[--shadow-button-color:var(--color-base-800)]"
>
  <!-- Media band: a real preview when the enricher found one, else a quiet
       accent plate so an unenriched link reads as intentional absence rather
       than a failed image load. -->
  <div class="relative aspect-video w-full overflow-hidden bg-base-200/60 dark:bg-base-800/50">
    {#if videoUrl}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        muted
        preload="metadata"
        playsinline
        class="h-full w-full object-cover"
        poster={thumbnailUrl}
        src={videoUrl}
      ></video>
      <div class="absolute inset-0 flex items-center justify-center">
        <span
          class="flex size-11 items-center justify-center rounded-full bg-base-950/60 text-base-50 transition-transform duration-150 ease-out group-hover:scale-110 motion-reduce:transition-none"
        >
          <IconPlay class="size-6" />
        </span>
      </div>
    {:else if stillUrl}
      <img
        alt=""
        loading="lazy"
        class="h-full w-full object-cover transition-transform duration-150 ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        src={stillUrl}
      />
    {:else}
      <div
        class="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent-500/[0.09] to-accent-500/[0.02] text-accent-600/70 dark:text-accent-400/60"
      >
        <IconLink class="size-8" />
      </div>
    {/if}
  </div>

  <!-- Text well -->
  <div class="flex flex-1 flex-col gap-1 p-3">
    {#if sourceLine}
      <span class="truncate text-xs font-medium text-base-500 dark:text-base-400">
        {sourceLine}
      </span>
    {/if}

    <span
      class="line-clamp-2 text-sm font-semibold leading-snug text-base-900 dark:text-base-100"
    >
      {heading}
    </span>

    {#if description}
      <p class="line-clamp-2 text-xs leading-relaxed text-base-500 dark:text-base-400">
        {description}
      </p>
    {/if}
  </div>

  <!-- Footer rule: share date + the open affordance, which is the card's
       whole point and so stays visible rather than appearing on hover. -->
  <div
    class="mt-auto flex items-center justify-between gap-2 border-t border-base-200/70 px-3 py-2 dark:border-base-800/70"
  >
    {#if sharedAt}
      <time
        datetime={link.timestamp}
        title={sharedAt.exact}
        class="truncate text-xs text-base-500 dark:text-base-400"
      >
        {sharedAt.label}
      </time>
    {:else}
      <span class="truncate text-xs text-base-500 dark:text-base-400">{hostname}</span>
    {/if}

    <span
      class="flex shrink-0 items-center text-base-500 transition-colors duration-75 group-hover:text-accent-600 dark:text-base-400 dark:group-hover:text-accent-300 motion-reduce:transition-none"
      aria-hidden="true"
    >
      <IconArrowUpRight class="size-4" />
    </span>
  </div>
</a>
