<script lang="ts">
  import { page } from "$app/state";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import ThreadsTab from "$lib/components/thread/ThreadsTab.svelte";

  const spaceId = $derived(page.params.space!);

  // Visiting the index resets the stored destination so re-entering the space
  // from the server bar / space switcher lands here rather than the last room.
  $effect(() => {
    spaceNavigation.set(spaceId, { kind: "index" });
  });
</script>

<main class="h-full overflow-y-auto">
  <ThreadsTab {spaceId} />
</main>
