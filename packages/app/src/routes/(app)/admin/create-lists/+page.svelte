<script>
  import { Button } from "@fuxui/base";
  import {
    createAllAccountsList,
    createAllSpacesList,
    createDiscoverableSpacesList,
  } from "@roomy-chat/sdk";
</script>

<div class="flex flex-col gap-2 max-w-xl">
  <Button onclick={createAllSpacesList}>Create allSpacesListId</Button>
  <Button onclick={createAllAccountsList}>Create allAccountsListId</Button>
  <Button onclick={createDiscoverableSpacesList}
    >Create discoverableSpacesFeedId</Button
  >
</div>
