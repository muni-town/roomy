<script lang="ts">
  import { Modal, Heading } from "@foxui/core";
  import Input from "$lib/components/ui/input/Input.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { dmClient } from "$lib/dm.svelte";
  import { goto } from "$app/navigation";

  import { IconPlus } from "@roomy/design/icons";

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
      <IconPlus font-size="2em" />
      Start Conversation
    </Button>
  </form>
</Modal>
