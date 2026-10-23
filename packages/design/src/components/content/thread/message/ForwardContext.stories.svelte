<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ForwardContext from "./ForwardContext.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/ForwardContext",
    component: ForwardContext,
  });

  const timestamp = new Date("2026-10-02T12:00:00.000Z");
</script>

<Story
  name="Linked"
  args={{
    name: "Ada Lovelace",
    handle: "ada.test",
    did: "did:plc:abcdefghijklmnopqrstuvwx",
    timestamp,
    spaceId: "did:plc:drzgt2m6lmcel62gfbzjeap3",
    roomId: "01KZBRQMEP2FTE079YRVDFKGTA",
    messageId: "01KZBRQMEP2FTE079YRVDFKGTA",
  }}
/>

<Story
  name="Bridged"
  args={{
    name: "discord-user",
    did: "did:discord:1234567890",
    timestamp,
  }}
/>

<Story
  name="Handle only"
  args={{
    handle: "ada.test",
    did: "did:plc:abcdefghijklmnopqrstuvwx",
    timestamp,
  }}
/>

<Story name="No author" args={{ timestamp }} />
