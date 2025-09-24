<script lang="ts">
  import ChatArea from "./ChatArea.svelte";
  import ChatInputArea from "./ChatInputArea.svelte";

  const threading = $state({ active: false, selectedMessages: [], name: "" });
</script>

<div class="flex flex-col flex-1 h-full min-h-0 justify-stretch">
  <ChatArea {threading} />

  <div class="shrink-0">
    <ChatInputArea {threading} />
  </div>
</div>
