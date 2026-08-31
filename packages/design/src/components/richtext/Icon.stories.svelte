<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Icon from "./Icon.svelte";
  import type { RichTextTypes } from ".";

  const { Story } = defineMeta({
    title: "RichText/Icon",
    component: Icon,
  });

  const ALL_NAMES: RichTextTypes[] = [
    "paragraph",
    "heading-1",
    "heading-2",
    "heading-3",
    "blockquote",
    "small",
    "code",
    "bullet-list",
    "ordered-list",
  ];
</script>

{#snippet template(_args)}
  <div class="p-4">
    <div class="grid grid-cols-3 gap-4">
      {#each ALL_NAMES as name}
        <div class="flex flex-col items-center gap-2 p-3 border border-base-300 dark:border-base-700 rounded-xl">
          <Icon {name} />
          <span class="text-xs font-mono opacity-70">{name}</span>
        </div>
      {/each}
    </div>
  </div>
{/snippet}

<Story name="Default" {template} />
