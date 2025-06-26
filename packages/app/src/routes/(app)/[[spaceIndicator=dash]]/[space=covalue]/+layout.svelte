<script lang="ts">
  import { page } from "$app/state";
  import { initSearch } from "$lib/components/search/search.svelte";
  import { Space, wordlist } from "@roomy-chat/sdk";
  import { CoState, usePassphraseAuth } from "jazz-svelte";

  let { children } = $props();
  const auth = usePassphraseAuth({ wordlist });

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let hasStartedIndexing = $state(false);

  // load all channels and threads and subscribe to them and add them to search index
  // save last indexed message id for each channel and thread in local storage
  $effect(() => {
    if (!space.current) return;
    if (hasStartedIndexing) return;
    if (auth.state !== "signedIn") return;

    hasStartedIndexing = true;

    // load all channels and threads and subscribe to them and add them to search index
    // save last indexed message id for each channel and thread in local storage

    initSearch(space.current);
  });

</script>

{@render children()}
