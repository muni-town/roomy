<script>
  import { Button } from "@fuxui/base";
  import {
    createAllAccountsList,
    createAllSpacesList,
    createDiscoverableSpacesList,
  } from "@roomy-chat/sdk";
</script>

<div class="flex flex-col gap-2 max-w-sm">
  <Button onclick={createAllSpacesList}>Create Admin Spaces List</Button>
  <Button onclick={createAllAccountsList}>Create Admin Users List</Button>
  <Button onclick={createDiscoverableSpacesList}
    >Create Discoverable Spaces List</Button
  >
</div>
