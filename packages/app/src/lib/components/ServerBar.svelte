<script lang="ts">
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { co } from "jazz-tools";
  import { RoomyAccount, RoomyEntity, RoomyEntityList } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import { page } from "$app/state";
  import {
    TooltipProvider,
    Button,
    ThemeToggle,
    ScrollArea,
  } from "@fuxui/base";
  import { SelectThemePopover } from "@fuxui/colors";
  import CreateSpaceModal from "./modals/CreateSpaceModal.svelte";
  import User from "./User.svelte";
  import { user } from "$lib/user.svelte";

  let {
    spaces,
    me,
  }: {
    spaces: co.loaded<typeof RoomyEntityList> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  let isNewSpaceDialogOpen = $state(false);

  let openSpace = $derived(new CoState(RoomyEntity, page.params.space));

  let isOpenSpaceJoined = $derived(
    me?.profile?.newJoinedSpacesTest?.some(
      (x) => x?.id === openSpace.current?.id,
    ),
  );
</script>

<TooltipProvider>
  <div class="flex flex-col gap-1 items-center justify-center pt-2">
    <Button
      variant="link"
      type="button"
      onclick={() => navigate("home")}
      class="px-0 aspect-square [&_svg]:size-8"
      data-current={page.url.pathname.startsWith("/home")}
    >
      <Icon icon="tabler:home" font-size="1.75em" />
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
        <Icon icon="tabler:plus" font-size="2em" />
      </Button>
    {/if}

    <div class="divider my-0"></div>
    {#if !isOpenSpaceJoined && openSpace.current}
      <div class="py-2 flex">
        <SidebarSpace space={openSpace.current} hasJoined={false} />
      </div>
    {/if}
  </div>

  <div class="relative flex-grow h-full overflow-hidden isolate">
    <div
      class="absolute top-0 left-0 right-0 h-5 w-full bg-gradient-to-b from-base-100 dark:from-black to-transparent z-10"
    ></div>
    <div
      class="absolute bottom-0 left-0 right-0 h-5 w-full bg-gradient-to-t from-base-100 dark:from-black to-transparent z-10"
    ></div>

    <ScrollArea class="h-full overflow-y-auto overflow-x-hidden">
      <div class="flex flex-col px-0 items-center gap-1.5 py-4">
        {#if spaces}
          {#each new Set(spaces.toReversed()) as space}
            <SidebarSpace {space} />
          {/each}
        {/if}
      </div>
    </ScrollArea>
  </div>
  <section class="flex flex-col items-center gap-2 p-0 pb-2">
    <SelectThemePopover />
    <ThemeToggle class="backdrop-blur-none" />
    <User />
  </section>
</TooltipProvider>
