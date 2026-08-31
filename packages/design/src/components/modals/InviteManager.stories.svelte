<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import InviteManager from "./InviteManager.svelte";

  const { Story } = defineMeta({
    title: "Modals/InviteManager",
    component: InviteManager,
  });

  type Args = {
    open: boolean;
    invites: { token: string; createdBy: string; eventUlid: string }[];
  };
</script>

{#snippet template(args: Args)}
  <InviteManager
    {...(args as any)}
    urlFor={(token: string) => `https://roomy.space/i/${token}`}
    onCreate={() => {
      /* no-op in story */
    }}
    onRevoke={() => {
      /* no-op in story */
    }}
    onCopy={() => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story
  name="Default"
  args={{
    open: true,
    invites: [
      { token: "tok-1", createdBy: "alice", eventUlid: "01JX" },
      { token: "tok-2", createdBy: "bob", eventUlid: "01KZ" },
    ],
  }}
  {template}
/>

<Story name="Empty" args={{ open: true, invites: [] }} {template} />
