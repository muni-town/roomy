<script lang="ts">
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { Modal, Input, Button, Heading } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { co } from "jazz-tools";

  let {
    open = $bindable(false),
    entity = $bindable(null),
  }: {
    open: boolean;
    entity: co.loaded<typeof RoomyEntity> | undefined | null | null;
  } = $props();

  let entityName = $derived(entity?.name);

  async function save() {
    console.log("save", entityName, entity);
    if (!entityName || !entity) return;

    entity.name = entityName;

    open = false;
  }
  $inspect(entity);
</script>

<Modal bind:open>
  <form id="createSpace" class="flex flex-col gap-4" onsubmit={save}>
    <Heading>Change object name</Heading>
    <Input bind:value={entityName} placeholder="Name" type="text" required />
    <Button
      type="submit"
      disabled={!entityName}
      class="w-full justify-start"
      size="lg"
    >
      <Icon icon="basil:plus-outline" font-size="2em" />
      Save
    </Button>
  </form>
</Modal>
