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

<div
  class="not-prose max-w-[70ch] rounded-sm border-l-4 border-l-base-300 dark:border-l-base-700 bg-base-100/50 dark:bg-base-900/50 flex flex-col justify-stretch gap-4 min-[500px]:flex-row"
>
  <div class="min-w-0 flex-1 px-3 py-2 flex flex-col">
    {#if subtitle}
      <p class="mb-1 mt-0 text-sm leading-none opacity-70">
        {subtitle}
      </p>
    {/if}

    {#if title}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        class="mb-1 mt-1 line-clamp-2 max-w-prose leading-snug text-accent-600 dark:text-accent-400 hover:text-primary-focus font-bold"
      >
        {title}
      </a>
    {/if}

    {#if description}
      <p class="my-0 line-clamp-2 max-w-prose text-sm leading-tight">
        {description}
      </p>
    {/if}

    <div class="grow py-2"></div>

    {#if footerText}
      <p class="mt-2 mb-0 text-sm">{footerText}</p>
    {/if}

    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm leading-tight underline text-base-600 dark:text-base-400"
    >
      {url}
    </a>
  </div>

  {#if videoUrl}
    <div class="w-full flex-shrink-0 p-2 min-[500px]:max-w-40">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        muted
        class="my-0 h-full w-full rounded object-cover"
        poster={thumbnailUrl}
        src={videoUrl}
      >
      </video>
    </div>
  {:else if imageUrl}
    <div class="w-full flex-shrink-0 p-2 min-[500px]:max-w-40">
      <img
        alt=""
        class="m-0 h-full w-full rounded object-cover"
        src={imageUrl}
      />
    </div>
  {/if}
</div>
