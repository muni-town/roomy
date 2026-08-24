<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import { IconGlobe, IconHashtag } from "@roomy/design/icons";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let { channel }: { channel: SidebarChannel } = $props();
</script>

{#if channel.federated !== undefined}
  <IconGlobe
    class="shrink-0 size-3.5 text-base-500"
    aria-label="Federated from another space"
  />
{:else}
  <IconHashtag class="shrink-0 text-base-500" />
{/if}
