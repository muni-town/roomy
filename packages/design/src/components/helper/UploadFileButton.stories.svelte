<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UploadFileButton from "./UploadFileButton.svelte";

  const { Story } = defineMeta({
    title: "Helper/UploadFileButton",
    component: UploadFileButton,
  });
</script>

<Story
  name="Default"
  args={{ processImageFile: async (file: File) => {}, disabled: false }}
/>
