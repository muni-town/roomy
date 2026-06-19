<script lang="ts">
  /**
   * LinkCard — renders a rich link preview card from enriched embed data.
   *
   * The `embed` prop is the LinkEmbedData object returned by the appserver's
   * embed enricher (from the Lantern-chat embed-service). When embed data
   * is still pending or unavailable, only the URL is shown.
   */

  import type { schemas } from "@roomy-space/sdk";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

  let {
    embed,
    url,
  }: {
    embed: LinkEmbedData | null | undefined;
    url: string;
  } = $props();

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

  // Debug: log embed data to console for inspection
  $effect(() => {
    if (embed) {
      console.log(`[LinkCard] embed data for ${url}:`, embed);
    } else {
      console.log(`[LinkCard] no embed data yet for ${url}`);
    }
  });</script>

<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="not-prose max-w-[70ch] rounded-lg border border-base-400/60 dark:border-base-800 bg-base-100/50 dark:bg-base-900/50 flex flex-col justify-stretch gap-4 min-[500px]:flex-row hover:border-accent-400/60 dark:hover:border-accent-800 hover:bg-accent-50/40 dark:hover:bg-accent-900/20 transition-colors no-underline overflow-hidden"
>
  {#if videoUrl}
    <div class="w-full flex-shrink-0 min-[500px]:max-w-60 min-[500px]:self-stretch">
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
    <div class="w-full flex-shrink-0 min-[500px]:max-w-60 min-[500px]:self-stretch">
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
