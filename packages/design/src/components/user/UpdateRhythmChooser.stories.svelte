<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UpdateRhythmChooser, { type RhythmLevel } from "./UpdateRhythmChooser.svelte";

  const { Story } = defineMeta({
    title: "User/UpdateRhythmChooser",
    component: UpdateRhythmChooser,
  });

  type Args = {
    value: RhythmLevel;
    horizontal: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-full max-w-md">
    <UpdateRhythmChooser
      value={(args as any).value}
      horizontal={(args as any).horizontal}
      onchange={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ value: "engaged", horizontal: false }}
  {template}
/>

<Story
  name="Horizontal"
  args={{ value: "busy", horizontal: true }}
  {template}
/>
