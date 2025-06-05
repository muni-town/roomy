<script>
  import { Button, Checkbox, Popover } from "bits-ui";
  import { Drawer } from "vaul-svelte";
</script>

<Drawer bind:isDrawerOpen>
  <div class="flex gap-4 justify-center mb-4">
    <!-- <Button.Root
        onclick={() => {
          toggleReaction("👍");
          isDrawerOpen = false;
        }}
        class="dz-btn dz-btn-circle"
      >
        👍
      </Button.Root>
      <Button.Root
        onclick={() => {
          toggleReaction("😂");
          isDrawerOpen = false;
        }}
        class="dz-btn dz-btn-circle"
      > 
        😂
      </Button.Root>
    -->
    <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
      <Popover.Trigger class="dz-btn dz-btn-circle">
        <Icon icon="lucide:smile-plus" />
      </Popover.Trigger>
      <Popover.Content class="z-10">
        <emoji-picker bind:this={emojiDrawerPicker}></emoji-picker>
      </Popover.Content>
    </Popover.Root>
  </div>

  {#if authorProfile}
    <div class="dz-join dz-join-vertical w-full">
      {#if message instanceof Message && isReplyable}
        <Button.Root
          onclick={() => {
            setReplyTo(message);
            isDrawerOpen = false;
          }}
          class="dz-join-item dz-btn w-full"
        >
          <Icon icon="fa6-solid:reply" />
          Reply
        </Button.Root>
      {/if}
      <!-- {#if mayEdit}
          <Button.Root
            onclick={() => {
              startEditing();
              isDrawerOpen = false;
            }}
            class="dz-join-item dz-btn w-full"
          >
            <Icon icon="tabler:edit" />
            Edit
          </Button.Root>
        {/if} -->
      <!-- {#if mayDelete}
          <Button.Root
            onclick={() => deleteMessage()}
            class="dz-join-item dz-btn dz-btn-error w-full"
          >
            <Icon icon="tabler:trash" />
            Delete
          </Button.Root>
        {/if} -->
    </div>
  {/if}
</Drawer>
{#if !isEditing}
  <Toolbar.Root
    class={`${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-base-300 p-1 rounded items-center`}
  >
    <!-- <Toolbar.Button
      onclick={() => toggleReaction("👍")}
      class="dz-btn dz-btn-ghost dz-btn-square"
    >
      👍
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => toggleReaction("😂")}
      class="dz-btn dz-btn-ghost dz-btn-square"
    >
      😂
    </Toolbar.Button> -->
    <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
      <Popover.Trigger class="dz-btn dz-btn-ghost dz-btn-square">
        <Icon icon="lucide:smile-plus" />
      </Popover.Trigger>
      <Popover.Content class="z-10">
        <emoji-picker bind:this={emojiToolbarPicker}></emoji-picker>
      </Popover.Content>
    </Popover.Root>
    <!-- {#if mayEdit}
      <Toolbar.Button
        onclick={() => startEditing()}
        class="dz-btn dz-btn-ghost dz-btn-square"
      >
        <Icon icon="tabler:edit" />
      </Toolbar.Button>
    {/if} -->

    <!-- {#if mayDelete}
      <Toolbar.Button
        onclick={() => deleteMessage()}
        class="dz-btn dz-btn-ghost dz-btn-square"
      >
        <Icon icon="tabler:trash" class="text-warning" />
      </Toolbar.Button>
    {/if} -->

    {#if authorProfile}
      <Toolbar.Button
        onclick={() => setReplyTo(message)}
        class="dz-btn dz-btn-ghost dz-btn-square"
      >
        <Icon icon="fa6-solid:reply" />
      </Toolbar.Button>
    {/if}
  </Toolbar.Root>
{/if}

{#if isThreading.value}
  <Checkbox.Root
    onCheckedChange={updateSelect}
    bind:checked={isSelected}
    class="absolute right-4 inset-y-0"
  >
    <div
      class="border border-primary bg-base-100 text-primary-content size-4 rounded items-center cursor-pointer"
    >
      {#if isSelected}
        <Icon
          icon="material-symbols:check-rounded"
          class="bg-primary size-3.5"
        />
      {/if}
    </div>
  </Checkbox.Root>
{/if}
