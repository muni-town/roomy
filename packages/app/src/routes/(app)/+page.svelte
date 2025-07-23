<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import * as rawEnv from "$env/static/public";

  // @ts-ignore
  const defaultSpaceId = rawEnv.PUBLIC_DEFAULT_SPACE_ID;

  onMount(() => {
    // for hosted version where only one space is available directly go to it
    if (defaultSpaceId) {
      goto(`/${defaultSpaceId}`, { replaceState: true });
      return;
    }

    goto("/home", { replaceState: true });
  });
</script>
