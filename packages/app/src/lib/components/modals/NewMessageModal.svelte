<script lang="ts">
  import { Modal, Input, Button, Heading } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { dmClient } from "$lib/dm.svelte";
  import { goto } from "$app/navigation";
  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let handle = $state("");

  async function newMessageSubmit(evt: Event) {
    evt.preventDefault();
    if (!handle) return;
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;

    const conversation = await dmClient.startConversation(cleanHandle);
    handle = "";

    open = false;

    goto(`/messages/${conversation}`);
  }
</script>

<Modal bind:open>
  <form id="newMessage" class="flex flex-col gap-4" onsubmit={newMessageSubmit}>
    <Heading>Start a new conversation</Heading>
    <Input bind:value={handle} placeholder="Handle" type="text" required />
    <Button
      type="submit"
      disabled={!handle}
      class="w-full justify-center"
      size="lg"
    >
      <Icon icon="basil:plus-outline" font-size="2em" />
      Start Conversation
    </Button>
  </form>
</Modal>
