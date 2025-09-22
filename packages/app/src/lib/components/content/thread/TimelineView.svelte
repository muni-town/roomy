<script lang="ts">
  import ChatArea from "./ChatArea.svelte";
  import ChatInputArea from "./ChatInputArea.svelte";

  const threading = $state({ active: false, selectedMessages: [], name: "" });

</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <ChatArea
    {threading}
  />

  <ChatInputArea {threading} />
</div>
