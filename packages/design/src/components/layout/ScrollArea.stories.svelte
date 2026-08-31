<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ScrollArea from "./ScrollArea.svelte";

  const { Story } = defineMeta({
    title: "Layout/ScrollArea",
    component: ScrollArea,
  });

  type Args = {
    orientation: "vertical" | "horizontal" | "both";
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <div
      class="h-64 w-full max-w-md overflow-hidden rounded-lg border border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950"
    >
      <ScrollArea {...(args as any)}>
        <div class="flex flex-col gap-2 p-3">
          {#each Array.from({ length: 30 }, (_, i) => i + 1) as n}
            <p class="text-sm text-base-700 dark:text-base-300">
              Item {n} — Lorem ipsum dolor sit amet, consectetur adipiscing
              elit, sed do eiusmod tempor incididunt ut labore et dolore magna
              aliqua.
            </p>
          {/each}
        </div>
      </ScrollArea>
    </div>
  </div>
{/snippet}

<Story name="Default" args={{ orientation: "vertical" }} {template} />
