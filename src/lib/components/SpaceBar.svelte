<script lang="ts">
  import "../../app.css";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";

  import { AvatarMarble } from "svelte-boring-avatars";
  import { Avatar, Button, ToggleGroup } from "bits-ui";

  import { Space } from "@roomy-chat/sdk";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import UserSession from "$lib/components/UserSession.svelte";
  import { page } from "$app/state";

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let { spaces } = $props();

  async function createSpace() {
    if (!newSpaceName || !user.agent || !g.roomy) return;
    const space = await g.roomy.create(Space);
    space.name = newSpaceName;
    space.admins.push(user.agent.assertDid);
    space.commit();

    g.roomy.spaces.push(space);
    g.roomy.commit();
    newSpaceName = "";

    isNewSpaceDialogOpen = false;
  }
</script>

<aside
  class="flex flex-col justify-between align-center h-full px-1 py-4 border-r-2 border-base-200 bg-base-300"
>
  <ToggleGroup.Root
    type="single"
    value={g.currentCatalog}
    class="flex flex-col gap-2 align-center"
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
      {@debug space}
      <ContextMenu
        menuTitle={space.name}
        items={[
          {
            label: "Leave Space",
            icon: "mdi:exit-to-app",
            onselect: () => {
              g.roomy?.spaces.remove(i);
              g.roomy?.commit();
            },
          },
        ]}
      >
        <ToggleGroup.Item
          onclick={() => navigate({ space: space.handles.get(0) || space.id })}
          value={space.id}
          title={space.name}
          class="btn btn-ghost px-1 w-full rounded-3xlit justify-start flex data-[state=on]:border-base-content"
        >
          <Avatar.Root>
            <Avatar.Image />
            <Avatar.Fallback>
              <AvatarMarble name={space.id} size={33} />
            </Avatar.Fallback>
          </Avatar.Root>
        </ToggleGroup.Item>
      </ContextMenu>
    {/each}
  </ToggleGroup.Root>

  {#if !page.params.space}
    <div class="w-fit grid justify-center gap-2">
      <ThemeSelector class="px-1" />
      <UserSession class="px-1" />
    </div>
  {/if}
</aside>
