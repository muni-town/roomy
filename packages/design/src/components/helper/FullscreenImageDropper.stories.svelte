<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import FullscreenImageDropper from "./FullscreenImageDropper.svelte";

  const { Story } = defineMeta({
    title: "Helper/FullscreenImageDropper",
    component: FullscreenImageDropper,
  });
</script>

<Story
  name="Default"
  args={{ processImageFile: async (file: File) => {} }}
/>
