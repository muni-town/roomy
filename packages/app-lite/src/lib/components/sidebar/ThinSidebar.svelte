<script lang="ts">
  import { page } from "$app/state";
  import ScrollArea from "@roomy/design/components/layout/ScrollArea.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import UserMenu from "@roomy/design/components/user/UserMenu.svelte";
  import { IconSquaresPlus } from "@roomy/design/icons";
  import { logout } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";

  const spacesQuery = createSpacesQuery();

  const activeSpace = $derived(page.params.space);
  const connected = $derived(!!sync_.ctx);

  type LastLogin = { handle: string; did: string; avatar: string };
  let lastLogin = $state<LastLogin | undefined>(undefined);

  $effect(() => {
    const raw = localStorage.getItem("last-login");
    lastLogin = raw ? JSON.parse(raw) : undefined;
  });
</script>

<div class="flex flex-col gap-1 items-center justify-center pt-4">
  <Button
    variant="link"
    href="/"
    class="px-0 aspect-square [&_svg]:size-8 hover:bg-accent-500/20"
    data-current={page.url.pathname === "/"}
  >
    <IconSquaresPlus font-size="1.75em" />
  </Button>
  <div class="w-8 my-1 border-t border-base-300/50 dark:border-base-100/10"></div>
</div>

<div class="relative grow h-full overflow-hidden isolate">
  <ScrollArea class="h-full overflow-y-auto overflow-x-hidden">
    <div class="flex flex-col px-0 items-center gap-2 py-4">
      {#if spacesQuery.data}
        {#each spacesQuery.data.spaces as space (space.id)}
          {@const isActive = activeSpace === space.id}
          <a
            href={`/${space.id}`}
            title={space.name ?? space.id}
            class={[
              "size-10 rounded-full relative group outline-accent-500 transition-all duration-200 bg-base-300",
              isActive ? "outline-2 cursor-default" : "cursor-pointer hover:outline-3",
            ]}
          >
            <div class="flex items-center justify-center overflow-hidden rounded-full">
              <SpaceAvatar
                src={space.avatar ?? undefined}
                id={space.id}
                name={space.name ?? undefined}
                size={40}
              />
            </div>
          </a>
        {/each}
      {/if}
    </div>
  </ScrollArea>
</div>

<section class="flex flex-col items-center gap-2 p-0 pb-2">
  <UserMenu
    {connected}
    avatar={lastLogin?.avatar || undefined}
    displayName={lastLogin?.handle}
    handle={lastLogin?.handle}
    onLogout={logout}
  />
</section>
