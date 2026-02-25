<script lang="ts">
  import { getAppState } from "$lib/queries";

  const app = getAppState();
  import { navigate } from "$lib/utils.svelte";

  $effect(() => {
    if (!app.joinedSpace) return;
    const firstCategory = app.categories?.[0];
    if (firstCategory?.type === "space.roomy.category") {
      const firstChild = firstCategory.children?.[0]?.id;
      if (firstChild)
        navigate({
          space: app.joinedSpace.id,
          channel: firstChild,
        });
    }
  });
</script>
