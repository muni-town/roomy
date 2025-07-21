<script lang="ts">
  import { Modal, Heading } from "@fuxui/base";
  import Icon from "@iconify/svelte";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();
</script>

<Modal bind:open closeButton={false}>
  <Heading class="text-center">Joining Space</Heading>
  <div class="flex justify-center">
    <Icon icon="lucide:loader-circle" class="animate-spin" font-size="4em" />
  </div>
</Modal>
