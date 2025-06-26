<script lang="ts">
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { co } from "jazz-tools";
  import { RoomyAccount, Space, SpaceList } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";
  import { TooltipProvider, Button } from "@fuxui/base";
  import CreateSpaceModal from "./modals/CreateSpaceModal.svelte";
  import User from "./User.svelte";
  import { user } from "$lib/user.svelte";

  let {
    spaces,
    me,
  }: {
    spaces: co.loaded<typeof SpaceList> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  let isNewSpaceDialogOpen = $state(false);

  let openSpace = $derived(new CoState(Space, page.params.space));

  let isOpenSpaceJoined = $derived(
    me?.profile?.joinedSpaces?.some((x) => x?.id === openSpace.current?.id),
  );
</script>

<TooltipProvider>
  <div class="flex flex-col gap-1 items-center justify-center py-2">
    <Button
      variant="link"
      type="button"
      onclick={() => navigate("home")}
      class="px-0 aspect-square [&_svg]:size-8"
      data-current={page.url.pathname.startsWith("/home")}
    >
      <Icon icon="iconamoon:home-fill" font-size="1.75em" />
    </Button>

    {#if user.session}
      <!-- Messages Button -->
      <Button
        href="/messages"
        variant="link"
        data-current={page.url.pathname.startsWith("/messages")}
        class="aspect-square [&_svg]:size-8"
        title="Direct Messages"
      >
        <Icon icon="tabler:mail" font-size="1.75em" />
      </Button>

      <CreateSpaceModal {me} bind:open={isNewSpaceDialogOpen} />

      <Button
        variant="link"
        title="Create Space"
        class="aspect-square [&_svg]:size-8"
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
  <div class="flex-grow overflow-y-auto overflow-x-hidden">
    <div class="flex flex-col px-0 items-center gap-1.5">
      {#if spaces}
        {#each spaces as space}
          <SidebarSpace {space} {me} />
        {/each}
      {/if}
    </div>
  </div>

  <section class="flex flex-col items-center gap-2 p-0">
    <User />
  </section>
</TooltipProvider>
