<script lang="ts">
  import { page } from "$app/state";
  import { CoState } from "jazz-svelte";
  import { Space } from "@roomy-chat/sdk";

  import SidebarObjectList from "./SidebarObjectList.svelte";
  import MainSidebarSpace from "./MainSidebarSpace.svelte";

  let space = $derived(
    page.params?.space
      ? new CoState(Space, page.params.space, {
          resolve: {
            rootFolder: {
              childrenIds: true,
            },
          },
        })
      : null,
  );

</script>

<!-- Header -->
<MainSidebarSpace />

<div class="py-2 w-full px-2">
  <SidebarObjectList childrenIds={space?.current?.rootFolder?.childrenIds} />
</div>
