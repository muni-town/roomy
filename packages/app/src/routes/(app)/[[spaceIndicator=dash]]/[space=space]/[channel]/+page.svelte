<script lang="ts">
  import TimelineView from "$lib/components/TimelineView.svelte";
  import LinkView from "$lib/components/LinkView.svelte";
  import { g } from "$lib/global.svelte";
</script>

{#if g.channel?.name !== "@links"}
  <TimelineView />
{:else}
  <LinkView />
{/if}
