<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LinkView from "./LinkView.svelte";
  import type { LinkInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/LinkView",
    component: LinkView,
  });

  const links: LinkInfo[] = [
    {
      url: "https://svelte.dev/blog/runes",
      embed: {
        title: "Introducing runes",
        description:
          "Runes are an implementation detail — a compiler primitive that powers the reactive language inside .svelte files.",
        image: "https://placehold.co/640x360/ff3e00/ffffff?text=Svelte",
        provider: "Svelte",
      },
    },
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      embed: {
        title: "A video worth watching",
        description: "Two minutes, best served with sound.",
        video: "https://www.w3schools.com/html/mov_bbb.mp4",
        thumbnail: "https://placehold.co/640x360/0ea5e9/ffffff?text=Video",
        provider: "YouTube",
        author: "Rick Astley",
      },
    },
    {
      url: "https://github.com/muni-town/roomy",
      embed: {
        title: "muni-town/roomy",
        description:
          "A distributed, community-first chat platform built on AT Protocol.",
        thumbnail: "https://placehold.co/400x400/181717/ffffff?text=gh",
        provider: "GitHub",
        author: "muni-town",
      },
    },
    { url: "https://example.com/plain-url-with-no-embed-data" },
  ];
</script>

<Story
  name="Default"
  args={{ links, emptyMessage: "No links shared yet", hasMore: true, loadMore: () => {} }}
/>

{#snippet template(args: { links: LinkInfo[]; emptyMessage: string; hasMore: boolean })}
  <div class="h-96 w-full">
    <LinkView
      links={args.links}
      emptyMessage={args.emptyMessage}
      hasMore={args.hasMore}
      loadMore={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Empty"
  args={{ links: [], emptyMessage: "No links shared yet", hasMore: false }}
  {template}
/>
