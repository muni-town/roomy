<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import * as rawEnv from "$env/static/public";

  onMount(() => {
    // for hosted version where only one space is available directly go to it
    if (rawEnv.PUBLIC_DEFAULT_SPACE_ID) {
      goto(`/${rawEnv.PUBLIC_DEFAULT_SPACE_ID}`, { replaceState: true });
      return;
    }

    goto("/home", { replaceState: true });
  });
</script>
