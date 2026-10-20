<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { RICHTEXT_MIME } from "@roomy-space/sdk";
  import MessageContent from "./MessageContent.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/MessageContent",
    component: MessageContent,
  });

  /** The wire `content` for a rich-text body: base64 of the UTF-8 document. */
  function wire(doc: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  const markdown = `## Deploy notes

The **staging** deploy is green. See [the run](/did:plc:drzkh6g2lmcel62gfbzjeap3/01KZBRQMEP2FTE079YRVDFKGTA) for the log.

- one
- two

> Ship it.`;

  const richtext = wire({
    $type: "space.roomy.richtext.document",
    blocks: [
      { $type: "space.roomy.richtext.blocks#header", level: 2, text: "Deploy notes" },
      {
        $type: "space.roomy.richtext.blocks#text",
        text: "The staging deploy is green.",
        facets: [
          {
            index: { byteStart: 4, byteEnd: 11 },
            features: [{ $type: "space.roomy.richtext.facet#bold" }],
          },
        ],
      },
      { $type: "space.roomy.richtext.blocks#small", text: "Posted by the release bot." },
    ],
  });
</script>

{#snippet template(args: { content: string; mimeType?: string; tiles?: boolean })}
  <!-- The wrapper `MessageBubble` provides in the app, so the block
       typography (`.roomy-prose`) reads the way it does in a message row. -->
  <div class="p-4 w-full max-w-2xl bg-base-50 dark:bg-base-950">
    <div
      class="roomy-prose prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline text-sm font-normal text-base-900 dark:text-base-100"
    >
      <MessageContent content={args.content} mimeType={args.mimeType} tiles={args.tiles} />
    </div>
  </div>
{/snippet}

<Story name="Markdown" args={{ content: markdown }} {template} />

<Story
  name="RichText"
  args={{ content: richtext, mimeType: RICHTEXT_MIME }}
  {template}
/>

<Story
  name="MalformedFallsBackToMarkdown"
  args={{ content: "# not a blocks document", mimeType: RICHTEXT_MIME }}
  {template}
/>

<Story name="TilesSuppressed" args={{ content: markdown, tiles: false }} {template} />
