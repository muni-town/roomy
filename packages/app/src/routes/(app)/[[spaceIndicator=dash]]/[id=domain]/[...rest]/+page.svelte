<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { navigate, resolveLeafId } from "$lib/utils.svelte";
  import { onMount } from "svelte";

  onMount(async () => {
    if (!page.params.id) return;
    const id = await resolveLeafId(page.params.id);

    if (!id) {
      console.error("Leaf ID not found for domain:", page.params.id);
      navigate("home");
      return;
    }

    goto(`/${id}?migrateDomain=true`);
  });
</script>