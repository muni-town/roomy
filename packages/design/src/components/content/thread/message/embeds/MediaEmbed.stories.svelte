<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MediaEmbed from "./MediaEmbed.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/Embeds/MediaEmbed",
    component: MediaEmbed,
  });

  /** A 1x1 PNG, so the image branch renders without a network fetch. */
  const PIXEL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  const image = [{ url: PIXEL, type: "image/png", alt: "A single pixel" }];
</script>

<Story
  name="Image"
  args={{ media: image }}
/>

<Story
  name="Video"
  args={{
    media: [
      {
        url: "https://www.w3schools.com/html/mov_bbb.mp4",
        type: "video/quicktime",
        alt: "A short clip",
      },
    ],
  }}
/>

<Story
  name="File"
  args={{
    media: [
      {
        url: "https://example.com/report.pdf",
        type: "application/pdf",
        alt: "Quarterly report",
      },
    ],
  }}
/>

<Story
  name="Mixed"
  args={{
    media: [
      ...image,
      { url: "https://example.com/report.pdf", type: "application/pdf" },
    ],
  }}
/>

<Story name="Empty" args={{ media: [] }} />
