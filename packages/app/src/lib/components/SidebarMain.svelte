<script lang="ts">
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import {
    RoomyAccount,
    RoomyEntity,
    ChildrenComponent,
  } from "@roomy-chat/sdk";

  import SidebarObjectList from "./SidebarObjectList.svelte";
  import MainSidebarSpace from "./MainSidebarSpace.svelte";

  let space = $derived(
    page.params?.space
      ? new CoState(RoomyEntity, page.params.space, {
          resolve: {
            components: {
              $each: true,
              $onError: null,
            },
          },
        })
      : null,
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let children = $derived(
    new CoState(
      ChildrenComponent.schema,
      space?.current?.components?.[ChildrenComponent.id],
      {
        resolve: {
          $each: {
            components: {
              $each: true,
              $onError: null,
            },
            $onError: null,
          },
        },
      },
    ),
  );
</script>

<!-- Header -->
<MainSidebarSpace />

<div class="w-full py-2 px-2">
  <SidebarObjectList children={children.current} me={me.current} />
</div>
