<script lang="ts">
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { co } from "jazz-tools";
  import { createSpace, createSpaceList } from "$lib/jazz/utils";
  import { RoomyAccount, Space, SpaceList } from "$lib/jazz/schema";
  import Login from "./Login.svelte";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";
  import Sidebar from "./ui/Sidebar.svelte";
  import { ScrollArea, TooltipProvider, Button } from "@fuxui/base";
  import CreateSpaceModal from "./modals/CreateSpaceModal.svelte";
  import User from "./User.svelte";

  let {
    spaces,
    visible,
    me,
  }: {
    spaces: co.loaded<typeof SpaceList> | undefined | null;
    visible: boolean;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  let isNewSpaceDialogOpen = $state(false);

  let openSpace = $derived(new CoState(Space, page.params.space));

  let isOpenSpaceJoined = $derived(
    me?.profile?.joinedSpaces?.some((x) => x?.id === openSpace.current?.id),
  );
</script>

<!-- Width manually set for transition to w-0 -->
<!-- <aside
  class="flex flex-col justify-between align-center h-screen {visible
    ? 'w-[60px] px-1 border-r-2'
    : 'w-[0]'} py-2 border-base-200 bg-base-300 transition-[width] duration-100 ease-out"
  class:opacity-0={!visible}
> -->
<Sidebar>
  <div class="flex flex-col gap-1 items-center justify-center py-2">
    <Button
      variant="link"
      type="button"
      onclick={() => navigate("home")}
      class="px-1 aspect-square [&_svg]:size-8"
      data-current={page.url.pathname.startsWith("/home")}
    >
      <Icon icon="iconamoon:home-fill" font-size="1.75em" />
    </Button>

    <!-- Messages Button -->
    <!-- <Button
      href="/messages"
      variant="link"
      data-current={page.url.pathname.startsWith("/messages")}
      class="px-1 aspect-square [&_svg]:size-8"
      title="Direct Messages"
    >
      <Icon icon="tabler:mail" font-size="1.75em" />
    </Button> -->

    {#if me?.profile?.blueskyHandle}
      <CreateSpaceModal {me} bind:open={isNewSpaceDialogOpen} />

      <Button
        variant="link"
        title="Create Space"
        class="p-2 aspect-square rounded-lg cursor-pointer [&_svg]:size-8"
        onclick={() => (isNewSpaceDialogOpen = true)}
      >
        <Icon icon="basil:add-solid" font-size="2em" />
      </Button>
    {/if}

    <div class="divider my-0"></div>
    {#if !isOpenSpaceJoined && openSpace.current}
      <SidebarSpace space={openSpace.current} hasJoined={false} {me} />
    {/if}
  </div>
  <ScrollArea class="flex-grow">
    <TooltipProvider>
      <div
        class="flex flex-col px-2 items-center flex-grow h-full overflow-y-auto"
      >
        {#if spaces}
          {#each spaces as space}
            <SidebarSpace {space} {me} />
          {/each}
        {/if}
      </div>
    </TooltipProvider>
  </ScrollArea>

  <section class="flex flex-col items-center gap-2 p-0">
    <User />
  </section>
</Sidebar>
<!-- </aside> -->
