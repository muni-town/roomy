<script lang="ts">
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import { user } from "$lib/user.svelte";

  async function addEntityToZip(zip: any, entity: any) {
    var id = entity.entity.id.toString();
    var doc = entity.entity.doc;

    if (id in zip.files) return;

    zip.file(id, doc.export({ mode: "snapshot" }));

    if ("timeline" in entity) {
      await addEntityListToZip(zip, entity.timeline);
    }
  }

  async function addEntityListToZip(zip: any, entity_list: any) {
    var items = await entity_list.items();
    for (var i in items) {
      await addEntityToZip(zip, items[i]);
    }
  }

  // async function exportZip() {
  //   var metadata: { Type: string; Version: string; [key: string]: any } = {
  //     Type: "RoomyData",
  //     Version: "0",
  //   };

  //   var zip = new JSZip();

  //   // var space = globalState.space;
  //   const space = null
  //   if (!space) return;

  //   metadata["space_id"] = space.entity.id.toString();

  //   await addEntityToZip(zip, space);

  //   await addEntityListToZip(zip, space.threads);
  //   await addEntityListToZip(zip, space.channels);
  //   await addEntityListToZip(zip, space.wikipages);

  //   zip.file("meta.json", JSON.stringify(metadata));

  //   zip.generateAsync({ type: "blob" }).then(function (content) {
  //     FileSaver.saveAs(content, "roomy-data.zip");
  //   });
  // }
</script>

<Button.Root
  title="Export ZIP Archive"
  class="p-2 aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
  disabled={!user.session}
>
  <Icon icon="mdi:folder-download-outline" font-size="1.8em" />
</Button.Root>
