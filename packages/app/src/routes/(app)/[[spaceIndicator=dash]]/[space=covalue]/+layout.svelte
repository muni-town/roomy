<script lang="ts">
  import { page } from "$app/state";
  import { initSearch } from "$lib/components/search/search.svelte";
  import { Space } from "$lib/jazz/schema";
  import { wordlist } from "$lib/jazz/wordlist";
  import { CoState, usePassphraseAuth } from "jazz-svelte";
  import { atprotoFeedService } from "$lib/services/atprotoFeedService";

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
  let hasStartedAtprotoFeeds = $state(false);

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

  // Start ATProto feed service for this space
  $effect(() => {
    if (!space.current || !space.current.channels) return;
    if (hasStartedAtprotoFeeds) return;
    if (auth.state !== "signedIn") return;

    hasStartedAtprotoFeeds = true;

    // Find ATProto feed channels
    const atprotoChannels = space.current.channels.filter(
      (channel) => channel?.isAtprotoFeed,
    );

    if (atprotoChannels.length > 0) {
      atprotoFeedService.startAutoUpdate(atprotoChannels);
    }

    // Cleanup when component unmounts
    return () => {
      atprotoFeedService.stopAutoUpdate();
    };
  });
</script>

{@render children()}
