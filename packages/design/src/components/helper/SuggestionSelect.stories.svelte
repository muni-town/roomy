<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SuggestionSelect, {
    type SuggestionItem,
  } from "./SuggestionSelect.svelte";

  const { Story } = defineMeta({
    title: "Helper/SuggestionSelect",
    component: SuggestionSelect,
  });

  const items: SuggestionItem[] = [
    { value: "alice", label: "Alice", category: "Users" },
    { value: "bob", label: "Bob the Builder", category: "Users" },
    { value: "general", label: "general", category: "Channels" },
    { value: "random", label: "random", disabled: true, category: "Channels" },
  ];
</script>

<Story
  name="Default"
  args={{ items, callback: () => {} }}
/>
