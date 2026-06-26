<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconPlus } from "@roomy/design/icons";
</script>

<div class="flex flex-col sm:flex-row items-center gap-4">
  <Button variant="primary" size="lg" href="/new">
    <IconPlus class="size-5" />
    Create a Space
  </Button>
</div>