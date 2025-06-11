<script lang="ts">
  import { page } from '$app/state';
  import { initSearch } from '$lib/components/search/search.svelte';
  import { Space } from '$lib/jazz/schema';
  import { CoState } from 'jazz-svelte';

  let { children } = $props();

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

    hasStartedIndexing = true;

    // load all channels and threads and subscribe to them and add them to search index
    // save last indexed message id for each channel and thread in local storage

    initSearch(space.current);
  });
</script>

<main
  class="flex flex-col gap-4 p-4 grow min-w-0 h-full overflow-clip bg-base-100"
>
  {@render children()}
</main>
