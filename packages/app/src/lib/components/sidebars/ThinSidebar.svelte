<script lang="ts">
  import { navigate } from "$lib/utils.svelte";
  import SidebarSpace from "./ThinSidebarSpace.svelte";
  import { page } from "$app/state";
  import { Button, ThemeToggle, ScrollArea } from "@fuxui/base";
  import { SelectThemePopover } from "@fuxui/colors";
  import UserProfileButton from "../user/UserProfileButton.svelte";
  import { current, joinedSpaces } from "$lib/queries";
  import { dev } from "$app/environment";

  import IconTablerPlus from "~icons/tabler/plus";
  import IconTablerHome from "~icons/tabler/home";
  import IconMdiSqlQuery from "~icons/mdi/sql-query";

  let openSpace = $derived(current.joinedSpace?.id);
  let isOpenSpaceJoined = $derived(true);
</script>

<div class="flex flex-col gap-1 items-center justify-center pt-2">
  <Button
    variant="link"
    type="button"
    onclick={() => navigate("home")}
    class="px-0 aspect-square [&_svg]:size-8"
    data-current={page.url.pathname.startsWith("/home")}
  >
    <IconTablerHome font-size="1.75em" />
  </Button>

  {#if current.did}
    <!-- Messages Button -->
    <!-- <Button
        href="/messages"
        variant="link"
        data-current={page.url.pathname.startsWith("/messages")}
        class="aspect-square [&_svg]:size-8"
        title="Direct Messages"
      >
        <Icon icon="tabler:mail" font-size="1.75em" />
      </Button> -->

    <Button
      variant="link"
      title="Create Space"
      class="aspect-square [&_svg]:size-8"
      href="/new"
      data-current={page.url.pathname.startsWith("/new")}
    >
      <IconTablerPlus font-size="2em" />
    </Button>
  {/if}

  <div class="divider my-0"></div>
  {#if !isOpenSpaceJoined && openSpace}
    <div class="py-2 flex">
      <!-- <SidebarSpace space={openSpace} hasJoined={false} /> -->
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
    <div class="flex flex-col px-0 items-center gap-2 py-4">
      {#each joinedSpaces.list as space (space.id)}
        <SidebarSpace {...space} />
      {/each}
    </div>
  </ScrollArea>
</div>
<section class="flex flex-col items-center gap-2 p-0 pb-2">
  {#if dev}
    <a href="/query">
      <IconMdiSqlQuery font-size="2em" />
    </a>
  {/if}
  <SelectThemePopover />
  <ThemeToggle class="backdrop-blur-none" />
  <UserProfileButton />
</section>
