<script lang="ts">
  import { page } from "$app/state";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";

  const spaceId = $derived(page.params.space!);
  const metaQuery = createSpaceMetadataQuery(() => spaceId);
</script>

<div class="max-w-2xl">
  <h2 class="text-base font-semibold mb-3">General</h2>

  {#if metaQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if metaQuery.isError}
    <p class="text-sm text-red-600">{metaQuery.error.message}</p>
  {:else if metaQuery.data}
    {@const m = metaQuery.data}
    <dl class="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
      <dt class="text-base-500">Name</dt>
      <dd>{m.name || "(unnamed)"}</dd>
      <dt class="text-base-500">DID</dt>
      <dd class="font-mono break-all text-xs">{spaceId}</dd>
      <dt class="text-base-500">Description</dt>
      <dd>{m.description || "—"}</dd>
    </dl>
    <p class="text-xs text-base-400 mt-4">Editing general settings is not yet wired in app-lite.</p>
  {/if}
</div>
