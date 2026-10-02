<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LinkViewItem from "./LinkViewItem.svelte";
  import type { LinkInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/LinkViewItem",
    component: LinkViewItem,
  });

  const rich: LinkInfo = {
    url: "https://svelte.dev/blog/runes",
    embed: {
      title: "Introducing runes",
      description:
        "Runes are an implementation detail — a compiler primitive that powers the reactive language inside .svelte files.",
      image: "https://placehold.co/640x360/ff3e00/ffffff?text=Svelte",
      provider: "Svelte",
    },
  };

  const video: LinkInfo = {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    embed: {
      title: "A video worth watching",
      description: "Two minutes, best served with sound.",
      video: "https://www.w3schools.com/html/mov_bbb.mp4",
      thumbnail: "https://placehold.co/640x360/0ea5e9/ffffff?text=Video",
      provider: "YouTube",
      author: "Rick Astley",
    },
  };

  const bare: LinkInfo = { url: "https://example.com/plain-url-with-no-embed-data" };

  const thumbnailOnly: LinkInfo = {
    url: "https://github.com/muni-town/roomy",
    embed: {
      title: "muni-town/roomy",
      description:
        "A distributed, community-first chat platform built on AT Protocol.",
      thumbnail: "https://placehold.co/400x400/181717/ffffff?text=gh",
      provider: "GitHub",
      author: "muni-town",
    },
  };
</script>

{#snippet template(args: { link: LinkInfo })}
  <div class="w-full @container">
    <LinkViewItem link={args.link} />
  </div>
{/snippet}

<Story name="With image" args={{ link: rich }} {template} />
<Story name="With video" args={{ link: video }} {template} />
<Story name="Thumbnail only" args={{ link: thumbnailOnly }} {template} />
<Story name="No embed data" args={{ link: bare }} {template} />
