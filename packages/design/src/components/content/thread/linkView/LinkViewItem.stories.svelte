<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LinkViewItem from "./LinkViewItem.svelte";
  import type { LinkInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/LinkViewItem",
    component: LinkViewItem,
  });

  /** Fixed timestamps so the stories render deterministically. */
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  /** A supplied handler is what makes the card show its action button. */
  const noop = () => {};

  const rich: LinkInfo = {
    url: "https://svelte.dev/blog/runes",
    timestamp: hoursAgo(2),
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
    timestamp: hoursAgo(9),
    embed: {
      title: "A video worth watching",
      description: "Two minutes, best served with sound.",
      video: "https://www.w3schools.com/html/mov_bbb.mp4",
      thumbnail: "https://placehold.co/640x360/0ea5e9/ffffff?text=Video",
      provider: "YouTube",
      author: "Rick Astley",
    },
  };

  const bare: LinkInfo = {
    url: "https://example.com/plain-url-with-no-embed-data",
    timestamp: hoursAgo(26),
  };

  /** A thumbnail but no landscape image — the media band still gets a face. */
  const thumbnailOnly: LinkInfo = {
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
  };

  /** An older server omits `timestamp` — the footer falls back to the host. */
  const undated: LinkInfo = {
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

  /** An unparseable `timestamp` must degrade to the host, never "Invalid Date". */
  const badDate: LinkInfo = {
    url: "https://example.com/garbage-timestamp",
    timestamp: "not-a-date",
    embed: { title: "A link with a broken timestamp", provider: "Example" },
  };

  /** Absolute dates past a week, and clamping on both text lines. */
  const long: LinkInfo = {
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
  };
</script>

{#snippet template(args: { link: LinkInfo })}
  <div class="w-[19rem] @container">
    <LinkViewItem link={args.link} />
  </div>
{/snippet}
{#snippet actionsTemplate(args: {
  link: LinkInfo;
  onCreateCard?: (link: LinkInfo) => void;
  onSaveToCollection?: (link: LinkInfo) => void;
})}
  <div class="w-[19rem] @container">
    <LinkViewItem
      link={args.link}
      onCreateCard={args.onCreateCard}
      onSaveToCollection={args.onSaveToCollection}
    />
  </div>
{/snippet}

<Story name="With image" args={{ link: rich }} {template} />
<Story name="With video" args={{ link: video }} {template} />
<Story name="Thumbnail only" args={{ link: thumbnailOnly }} {template} />
<Story name="No embed data" args={{ link: bare }} {template} />
<Story name="No timestamp" args={{ link: undated }} {template} />
<Story name="Broken timestamp" args={{ link: badDate }} {template} />
<Story name="Long copy" args={{ link: long }} {template} />

<!--
  The two ellipsis states. The card shows the top-right button whenever a
  handler is supplied; the menu itself portals, so open it by clicking the
  button to see the two Semble rows.
-->
<Story
  name="Admin actions"
  args={{ link: rich, onCreateCard: noop, onSaveToCollection: noop }}
  template={actionsTemplate}
/>

<Story
  name="Member actions"
  args={{ link: rich, onSaveToCollection: noop }}
  template={actionsTemplate}
/>
