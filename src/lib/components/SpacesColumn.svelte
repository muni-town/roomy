<script lang="ts">
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button, ToggleGroup } from "bits-ui";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import { Space } from "@roomy-chat/sdk";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import UserSession from "$lib/components/UserSession.svelte";
  import { page } from "$app/state";

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let {
    spaces,
    visible,
  }: {
    spaces: { value: Space[] };
    visible: boolean;
  } = $props();

  async function createSpace() {
    if (!newSpaceName || !user.agent || !g.roomy) return;
    const space = await g.roomy.create(Space);
    space.name = newSpaceName;
    space.admins((x) => x.push(user.agent!.assertDid));
    space.commit();

    g.roomy.spaces.push(space);
    g.roomy.commit();
    newSpaceName = "";

    isNewSpaceDialogOpen = false;
  }
</script>

<!-- Server Bar -->
<!-- Width manually set for transition to w-0 -->
<aside
  class="flex flex-col justify-between align-center h-full {visible
    ? 'w-[60px] px-1 border-r-2'
    : 'w-[0]'} py-2 border-base-200 bg-base-300 transition-[width] duration-100 ease-out"
  class:opacity-0={!visible}
>
  <ToggleGroup.Root
    type="single"
    value={g.currentCatalog}
    class="flex flex-col gap-2 items-center"
  >
    <ToggleGroup.Item
      value="home"
      onclick={() => navigate("home")}
      class="btn btn-ghost px-1 w-full data-[state=on]:border-accent"
    >
      <Icon icon="iconamoon:home-fill" font-size="1.75em" />
    </ToggleGroup.Item>

    <Dialog
      title="Create Space"
      description="Create a new public chat space"
      bind:isDialogOpen={isNewSpaceDialogOpen}
      disabled={!user.session}
    >
      {#snippet dialogTrigger()}
        <Button.Root title="Create Space" class="btn btn-ghost px-1 w-full">
          <Icon icon="basil:add-solid" font-size="2em" />
        </Button.Root>
      {/snippet}

      <form class="flex flex-col gap-4" onsubmit={createSpace}>
        <input
          bind:value={newSpaceName}
          placeholder="Name"
          class="input w-full"
        />
        <Button.Root disabled={!newSpaceName} class="btn btn-primary">
          <Icon icon="basil:add-outline" font-size="1.8em" />
          Create Space
        </Button.Root>
      </form>
    </Dialog>

    {#each spaces.value as space, i}
      <SidebarSpace {space} {i} />
    {/each}
  </ToggleGroup.Root>

  {#if !page.params.space}
    <div class="w-fit grid justify-center gap-2">
      <ThemeSelector class="px-1" />
      <UserSession class="px-1" />
    </div>
  {/if}
</aside>
