<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import * as rawEnv from "$env/static/public";

  onMount(() => {
    if (rawEnv.PUBLIC_DEFAULT_SPACE_ID) {
      goto(`/${rawEnv.PUBLIC_DEFAULT_SPACE_ID}`, { replaceState: true });
      return;
    }
    
    goto("/home", { replaceState: true });
  });
</script>
