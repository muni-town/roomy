<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LinkView from "./LinkView.svelte";
  import type { LinkInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/LinkView",
    component: LinkView,
  });

  /** Timestamps are fixed so the stories render deterministically. */
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  const links: LinkInfo[] = [
    {
      url: "https://svelte.dev/blog/runes",
      timestamp: hoursAgo(2),
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
      timestamp: hoursAgo(9),
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
      timestamp: hoursAgo(30),
      embed: {
        title: "muni-town/roomy",
        description:
          "A distributed, community-first chat platform built on AT Protocol.",
        thumbnail: "https://placehold.co/400x400/181717/ffffff?text=gh",
        provider: "GitHub",
        author: "muni-town",
      },
    },
    { url: "https://example.com/plain-url-with-no-embed-data", timestamp: hoursAgo(26) },
    {
      url: "https://www.are.na/some/longer-title-that-needs-two-lines-to-fit-in-a-card",
      timestamp: new Date(now - 40 * 86_400_000).toISOString(),
      embed: {
        title:
          "A deliberately long link title that has to clamp to two lines inside a narrow card",
        description:
          "And a description long enough to also need clamping, so the story exercises the line-clamp behaviour rather than the short-copy happy path.",
        image: "https://placehold.co/640x360/64748b/ffffff?text=are.na",
        provider: "Are.na",
      },
    },
  ];
</script>

{#snippet template(args: {
  links: LinkInfo[];
  emptyMessage?: string;
  hasMore?: boolean;
  loading?: boolean;
})}
  <div class="h-[38rem] w-full bg-base-50 dark:bg-base-950">
    <LinkView
      links={args.links}
      emptyMessage={args.emptyMessage}
      hasMore={args.hasMore}
      loading={args.loading}
      loadMore={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Grid"
  args={{ links, emptyMessage: "No links shared yet", hasMore: true }}
  {template}
/>

<Story name="Loading" args={{ links: [], loading: true }} {template} />

<Story
  name="Empty"
  args={{ links: [], emptyMessage: "No links shared yet", hasMore: false }}
  {template}
/>

<Story name="Load more" args={{ links: links.slice(0, 3), hasMore: true }} {template} />
