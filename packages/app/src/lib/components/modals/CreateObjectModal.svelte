<script lang="ts">
  // TODO: allow adding folders and pages too
  // TODO: add a way to select the parent object
  import { navigate } from "$lib/utils.svelte";
  import { Modal, Input, Button, Heading } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { createThread, Space } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";
  import { co, Group } from "jazz-tools";

  let {
    open = $bindable(false),
    space,
  }: {
    open: boolean;
    space: co.loaded<typeof Space> | undefined | null;
  } = $props();

  let newObjectName = $state("");
  let adminGroup = $derived(new CoState(Group, space?.adminGroupId));

  async function createObjectSubmit(evt: Event) {
    evt.preventDefault();
    if (!newObjectName) return;

    if (!adminGroup.current || !space) return;

    // add thread
    const thread = createThread(newObjectName, adminGroup.current);

    // add to root folder
    space.rootFolder?.childrenIds?.push(thread.roomyObject.id);
    space.threads?.push(thread.roomyObject);

    navigate({ space: space.id, object: thread.roomyObject.id });

    open = false;
  }
</script>

<Modal bind:open>
  <form
    id="createSpace"
    class="flex flex-col gap-4 isolate"
    onsubmit={createObjectSubmit}
  >
    <Heading>Create a new object</Heading>
    <Input bind:value={newObjectName} placeholder="Name" type="text" required />

    <Button
      type="submit"
      disabled={!newObjectName}
      class="w-full justify-start"
      size="lg"
    >
      <Icon icon="basil:plus-outline" font-size="2em" />
      Create Object
    </Button>
  </form>
</Modal>
