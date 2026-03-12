<script lang="ts">
  import { IconLoading } from "@roomy/design/icons";

  const { size = 40 }: { size?: number } = $props();
</script>

<IconLoading class="animate-spin" font-size={size} />
