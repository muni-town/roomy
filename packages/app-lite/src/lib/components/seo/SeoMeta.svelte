<script lang="ts">
  import { base } from "$app/paths";

  let {
    title,
    description,
    image,
    url,
    type = "website",
    siteName = "Roomy",
  }: {
    title: string;
    description?: string | null;
    image?: string | null;
    url?: string | null;
    type?: "website" | "article" | "profile";
    siteName?: string;
  } = $props();

  const defaultImage = `${base}/logo/roomy_blob_flat.png`;
  const ogImage = $derived(image ?? defaultImage);
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description ?? siteName} />

  <!-- Open Graph -->
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description ?? siteName} />
  <meta property="og:image" content={ogImage} />
  <meta property="og:type" content={type} />
  <meta property="og:site_name" content={siteName} />
  {#if url}
    <meta property="og:url" content={url} />
  {/if}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description ?? siteName} />
  <meta name="twitter:image" content={ogImage} />
</svelte:head>
