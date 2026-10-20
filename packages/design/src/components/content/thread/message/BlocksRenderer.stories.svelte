<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import type { Block } from "@roomy-space/sdk";
  import BlocksRenderer from "./BlocksRenderer.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/BlocksRenderer",
    component: BlocksRenderer,
  });

  const rich = (text: string): Block =>
    ({
      $type: "space.roomy.richtext.blocks#text",
      text,
      facets: [
        {
          index: { byteStart: 0, byteEnd: 4 },
          features: [{ $type: "space.roomy.richtext.facet#bold" }],
        },
        {
          index: { byteStart: 5, byteEnd: 8 },
          features: [
            { $type: "space.roomy.richtext.facet#italic" },
            { $type: "space.roomy.richtext.facet#link", uri: "https://roomy.space" },
          ],
        },
      ],
    }) as Block;

  const prose: Block[] = [
    { $type: "space.roomy.richtext.blocks#header", level: 2, text: "Deploy notes" },
    rich("Bold, italic and a link in one line."),
    { $type: "space.roomy.richtext.blocks#blockquote", level: 1, text: "Ship it." },
    { $type: "space.roomy.richtext.blocks#small", text: "Posted by the release bot." },
  ];

  const lists: Block[] = [
    {
      $type: "space.roomy.richtext.blocks#orderedList",
      start: 3,
      items: [{ text: "third" }, { text: "fourth" }],
    },
    {
      $type: "space.roomy.richtext.blocks#unorderedList",
      items: [{ text: "one" }, { text: "two" }],
    },
  ];

  const media: Block[] = [
    { $type: "space.roomy.richtext.blocks#code", text: "pnpm --filter app-lite test:e2e" },
    { $type: "space.roomy.richtext.blocks#horizontalRule" },
    {
      $type: "space.roomy.richtext.blocks#image",
      uri: "https://placehold.co/600x200/6366f1/ffffff?text=tile",
      alt: "A placeholder image",
    },
  ];

  /**
   * Text that mixes the three anchor-producing facet types. The converter can
   * emit a `#link` and a `#roomRef` over the same bytes; only the first may
   * become an `<a>`, since nested anchors are invalid HTML.
   */
  const anchors: Block[] = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: "at the lobby now",
      facets: [
        {
          index: { byteStart: 7, byteEnd: 12 },
          features: [
            { $type: "space.roomy.richtext.facet#link", uri: "https://roomy.space/x" },
            { $type: "space.roomy.richtext.facet#roomRef", spaceId: "did:plc:drzkh6g2lmcel62gfbzjeap3" },
          ],
        },
        {
          index: { byteStart: 13, byteEnd: 16 },
          features: [
            { $type: "space.roomy.richtext.facet#didMention", did: "did:plc:jfgn7ipjw7ao5hmtrbdjiojn" },
          ],
        },
      ],
    },
  ];

  const unknown: Block[] = [
    { $type: "space.roomy.richtext.blocks#text", text: "before" },
    { $type: "space.roomy.richtext.blocks#futureThing", payload: 1 },
    { $type: "space.roomy.richtext.blocks#text", text: "after" },
  ];
</script>

{#snippet template(args: { blocks: Block[] })}
  <div class="p-4 w-full max-w-2xl bg-base-50 dark:bg-base-950">
    <div
      class="roomy-prose prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline text-sm font-normal text-base-900 dark:text-base-100"
    >
      <BlocksRenderer blocks={args.blocks} />
    </div>
  </div>
{/snippet}

<Story name="Prose" args={{ blocks: prose }} {template} />

<Story name="Lists" args={{ blocks: lists }} {template} />

<Story name="CodeRuleAndImage" args={{ blocks: media }} {template} />

<Story name="AnchorFacets" args={{ blocks: anchors }} {template} />

<Story name="UnknownBlock" args={{ blocks: unknown }} {template} />

<Story name="Empty" args={{ blocks: [] as Block[] }} {template} />
