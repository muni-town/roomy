<script lang="ts">
  import ChatInputArea from "./ChatInputArea.svelte";

  // import ChatArea from "./ChatArea.svelte";
</script>

<!-- <ChatArea
  allowedToInteract={hasJoinedSpace && !isBanned}
  {threading}
  {startThreading}
  {toggleSelect}
/> -->

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="grow">

  </div>

  <ChatInputArea />
</div>
