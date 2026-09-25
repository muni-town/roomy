<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import type { schemas } from "@roomy-space/sdk";
  import LinkCard from "./LinkCard.svelte";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

  const { Story } = defineMeta({
    title: "Content/Thread/Message/Embeds/LinkCard",
    component: LinkCard,
  });

  const url = "https://atproto.com/blog/atproto-and-the-open-web";

  const withImage: LinkEmbedData = {
    t: "AT Protocol and the open web",
    d: "An introduction to the AT Protocol: portable identity, interoperable data, and a federated social web.",
    p: { n: "atproto.com" },
    au: { n: "Bluesky" },
    imgs: [{ u: "https://atproto.com/img/atproto-card.png", w: 1200, h: 630 }],
    footer: { t: "Read on atproto.com" },
  };

  const withoutImage: LinkEmbedData = {
    t: "Roomy — a cozy home for your community",
    d: "Open source, built on the AT Protocol.",
    p: { n: "roomy.space" },
  };
</script>

{#snippet template(args: {
  embed: LinkEmbedData | null;
  url: string;
  onRemove?: () => void;
})}
  <div class="p-4 w-full max-w-2xl bg-base-50 dark:bg-base-950">
    <LinkCard embed={args.embed} url={args.url} onRemove={args.onRemove} />
  </div>
{/snippet}

<Story
  name="WithImage"
  args={{ embed: withImage, url }}
  {template}
/>

<Story
  name="WithoutImage"
  args={{ embed: withoutImage, url }}
  {template}
/>

<Story
  name="PlainLink"
  args={{ embed: null, url }}
  {template}
/>

<Story
  name="Removable"
  args={{
    embed: withImage,
    url,
    onRemove: () => {
      /* no-op in story */
    },
  }}
  {template}
/>
