<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // The Discord bridge moved into the Integrations page. Old links and
  // bookmarks land here, so forward them rather than rendering anything.
  onMount(() => {
    goto(`/${page.params.space}/settings/integrations`, { replaceState: true });
  });
</script>
