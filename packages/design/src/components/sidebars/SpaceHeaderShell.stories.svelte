<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceHeaderShell from "./SpaceHeaderShell.svelte";

  const { Story } = defineMeta({
    title: "Sidebars/SpaceHeaderShell",
    component: SpaceHeaderShell,
  });

  type Args = {
    spaceName: string;
    isAdmin: boolean;
    showInviteButton: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-64">
    <div
      class="rounded-lg border border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950"
    >
      <SpaceHeaderShell
        {...(args as any)}
        onCreateChannel={() => {
          /* no-op in story */
        }}
        onCreateCategory={() => {
          /* no-op in story */
        }}
        settingsHref="/settings"
        onInvite={() => {
          /* no-op in story */
        }}
        onLeave={() => {
          /* no-op in story */
        }}
        onToggleSpaceSelector={() => {
          /* no-op in story */
        }}
      >
        {#snippet avatar()}
          <div
            class="size-8 rounded-xl bg-accent-500 text-white flex items-center justify-center text-xs font-bold shrink-0"
            >MF</div
          >
        {/snippet}
      </SpaceHeaderShell>
    </div>
  </div>
{/snippet}

<Story
  name="Admin"
  args={{ spaceName: "Meri Forest", isAdmin: true, showInviteButton: true }}
  {template}
/>

<Story
  name="Member"
  args={{ spaceName: "Meri Forest", isAdmin: false, showInviteButton: false }}
  {template}
/>
