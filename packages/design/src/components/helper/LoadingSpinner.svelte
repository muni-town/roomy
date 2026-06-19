<script lang="ts">
  import { IconLoading } from "@roomy/design/icons";

  const { size = 40 }: { size?: number } = $props();
</script>

<IconLoading class="animate-spin text-base-800 dark:text-base-200" font-size={size} />
