<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";

  onMount(() => {
    // redirect to general settings
    goto(`/${page.params.space}/settings/general`);
  });
</script>