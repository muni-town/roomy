<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import SpaceHeaderShell from "./SpaceHeaderShell.svelte";

  const { Story } = defineMeta({
    title: "Sidebars/SpaceHeaderShell",
    component: SpaceHeaderShell,
    render: template,
  });

  type Args = ComponentProps<typeof SpaceHeaderShell> & {
    spaceName: string;
    spaceSelectorOpen: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-64">
    <div
      class="rounded-lg border border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950"
    >
      <SpaceHeaderShell
        spaceName={args.spaceName}
        spaceSelectorOpen={args.spaceSelectorOpen}
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
  name="Header"
  args={{ spaceName: "Test Space", spaceSelectorOpen: false }}
  {template}
/>

<Story
  name="Header with selector open"
  args={{ spaceName: "Test Space", spaceSelectorOpen: true }}
  {template}
/>
