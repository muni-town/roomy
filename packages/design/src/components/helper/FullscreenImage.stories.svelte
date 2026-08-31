<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import FullscreenImage from "./FullscreenImage.svelte";

  const { Story } = defineMeta({
    title: "Helper/FullscreenImage",
    component: FullscreenImage,
  });
</script>

<!--
  FullscreenImage renders a full-viewport overlay only while the deprecated
  module-level `fullscreenImage` state (src/show) has `show: true`. The global
  state cannot be driven from story args, so this story shows the idle render
  (nothing visible). To preview the overlay, set `fullscreenImage.show = true`
  from another module (e.g. an image click handler) at runtime.
-->
<Story name="Default" />
