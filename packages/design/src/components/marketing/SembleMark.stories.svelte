<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SembleMark from "./SembleMark.svelte";

  const { Story } = defineMeta({
    title: "Marketing/SembleMark",
    component: SembleMark,
  });

  type Args = { class: string };
</script>

{#snippet template(args: Args)}
  <div class="p-4 text-base-800 dark:text-base-200">
    <SembleMark class={args.class} />
  </div>
{/snippet}

<Story name="Default" args={{ class: "size-4" }} {template} />

<Story name="Large" args={{ class: "size-8" }} {template} />
