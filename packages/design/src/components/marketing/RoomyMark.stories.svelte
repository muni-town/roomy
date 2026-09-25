<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RoomyMark from "./RoomyMark.svelte";

  const { Story } = defineMeta({
    title: "Marketing/RoomyMark",
    component: RoomyMark,
  });

  type Args = { sizeClass: string };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <RoomyMark sizeClass={args.sizeClass} />
  </div>
{/snippet}

<Story name="Default" args={{ sizeClass: "size-8" }} {template} />

<Story name="Large" args={{ sizeClass: "size-16" }} {template} />
