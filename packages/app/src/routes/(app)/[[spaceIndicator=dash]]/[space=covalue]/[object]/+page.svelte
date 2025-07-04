<script lang="ts">
  import { page } from "$app/state";
  import TimelineView from "$lib/components/TimelineView.svelte";
</script>

<TimelineView
  objectId={page.params.object ?? ""}
  spaceId={page.params.space ?? ""}
/>
