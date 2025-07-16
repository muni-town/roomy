<script lang="ts">
  import { page } from "$app/state";
  import { CoState } from "jazz-tools/svelte";
  import { IDList, Space } from "@roomy-chat/sdk";

  import SidebarObjectList from "./SidebarObjectList.svelte";
  import MainSidebarSpace from "./MainSidebarSpace.svelte";

  let space = $derived(
    page.params?.space
      ? new CoState(Space, page.params.space, {
          resolve: {
            rootFolder: {
              components: {
                $each: true,
                $onError: null,
              },
            },
          },
        })
      : null,
  );

  let children = $derived(new CoState(IDList, space?.current?.rootFolder?.components?.children));
</script>

<!-- Header -->
<MainSidebarSpace />

<div class="w-full py-2 px-2">
  <SidebarObjectList childrenIds={children.current} />
</div>
