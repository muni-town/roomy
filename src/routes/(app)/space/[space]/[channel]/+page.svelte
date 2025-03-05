<script lang="ts">
  import _ from "underscore";
  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { getContext, setContext } from "svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover } from "bits-ui";

  import type {
    Did,
    Space,
    Channel,
    Ulid,
  } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let spaceContext = getContext("space") as { get value(): Autodoc<Space> | undefined };
  let space = $derived(spaceContext.value);
  let channel = $derived(space?.view.channels[page.params.channel]) as
    | Channel
    | undefined;
  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");

  let messageInput = $state({});
  let imageFiles: FileList | null = $state(null);

  // thread maker
  let isThreading = $state({ value: false });
  let threadTitleInput = $state("");
  let selectedMessages: Ulid[] = $state([]);
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message: Ulid) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (message: Ulid) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });
  setContext("deleteMessage", (message: Ulid) => {
    if (!space) { return; }
    space.change((doc) => {
      // TODO: don't remove from timeline, just delete ID? We need to eventually add a marker
      // showing the messages is deleted in the timeline.
      Object.values(doc.channels).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      Object.values(doc.threads).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      delete doc.messages[message];
    });
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state<{
    id: Ulid;
    authorProfile: { handle: string; avatarUrl: string };
    content: string;
  } | null>();

  setContext(
    "setReplyTo",
    (value: {
      id: Ulid;
      authorProfile: { handle: string; avatarUrl: string };
      content: string;
    }) => {
      replyingTo = value;
    },
  );

  setContext("toggleReaction", (id: Ulid, reaction: string) => {
    if (!space) return;

    space.change((doc) => {
      const did = user.profile.data?.did;
      if (!did) return;

      let reactions = doc.messages[id].reactions[reaction] ?? [];

      if (reactions.includes(did)) {
        if (doc.messages[id].reactions[reaction].length - 1 === 0) {
          delete doc.messages[id].reactions[reaction];
        } else {
          doc.messages[id].reactions[reaction] = reactions.filter(
            (actor: Did) => actor !== did,
          );
        }
      } else {
        if (!doc.messages[id].reactions) {
          // init reactions object
          doc.messages[id].reactions = {};
        }
        doc.messages[id].reactions[reaction] = [...reactions, did];
      }
    });
  });

  function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!space) return;

    space.change((doc) => {
      const id = ulid();
      const timeline = [];
      for (const id of selectedMessages) {
        timeline.push(`${id}`);
      }
      doc.threads[id] = {
        title: threadTitleInput,
        timeline,
      };
    });

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (!space) return;

    /* TODO: rework with tiptap?
    const images = imageFiles
      ? await Promise.all(
          Array.from(imageFiles).map(async (file) => {
            try {
              const resp = await user.uploadBlob(file);
              return {
                source: resp.url, // Use the blob reference from ATP
                alt: file.name,
              };
            } catch (error) {
              console.error("Failed to upload image:", error);
              toast.error("Failed to upload image", { position: "bottom-end" });
              return null;
            }
          }),
        ).then((results) =>
          results.filter(
            (result): result is NonNullable<typeof result> => result !== null,
          ),
        )
      : undefined;
    */

    space.change((doc) => {
      if (!user.agent) return;

      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: JSON.stringify(messageInput),
        ...(replyingTo && { replyTo: replyingTo.id }),
        
        // TODO: rework images with tiptap
        // ...(images && { images }),
      };
      doc.channels[page.params.channel].timeline.push(id);
    });

    messageInput = {};
    replyingTo = null;
    imageFiles = null;
  }

  //
  // Settings Dialog
  //

  let { value: isAdmin }: { value: boolean } = getContext("isAdmin");

  let mayUploadImages = $derived.by(() => {
    if (isAdmin) return true;
    if (!space) { return }

    let messagesByUser = Object.values(space.view.messages).filter(
      (x) => user.agent && x.author == user.agent.assertDid,
    );
    if (messagesByUser.length > 5) return true;
    return !!messagesByUser.find(
      (message) =>
        !!Object.values(message.reactions).find(
          (reactedUsers) =>
            !!reactedUsers.find((user) => !!space?.view.admins.includes(user)),
        ),
    );
  });
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  $effect(() => {
    if (!space) { return }
    channelNameInput = channel?.name || "";
    channelCategoryInput = Object.entries(space.view.categories).find(
      ([_id, category]) => category.channels.includes(page.params.channel),
    )?.[0];
  });

  function saveSettings() {
    space?.change((space) => {
      if (channelNameInput) {
        space.channels[page.params.channel].name = channelNameInput;
      }
      Object.entries(space.categories).forEach(([catId, category]) => {
        if (channelCategoryInput !== catId) {
          const idx = category.channels.indexOf(page.params.channel);
          if (idx !== -1) {
            category.channels.splice(idx, 1);
          }
        }
        if (channelCategoryInput) {
          const category = space.categories[channelCategoryInput];
          if (!category.channels.includes(page.params.channel)) {
            category.channels.push(page.params.channel);
          }
          const idx = space.sidebarItems.findIndex(
            (x) => x.type == "channel" && x.id == page.params.channel,
          );
          if (idx !== -1) {
            space.sidebarItems.splice(idx, 1);
          }
        } else if (
          !space.sidebarItems.find(
            (x) => x.type == "channel" && x.id == page.params.channel,
          )
        ) {
          space.sidebarItems.push({ type: "channel", id: page.params.channel });
        }
      });
    });
    showSettingsDialog = false;
  }

  // TODO: rework with tiptap
  async function handleImageSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    imageFiles = input.files;
  }

  async function handlePaste(event: ClipboardEvent) {
    if (!mayUploadImages) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles = new DataTransfer().files;
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          imageFiles = dataTransfer.files;
        }
      }
    }
  }
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" color="white" />
      </Button.Root>
    {:else}
      <AvatarImage avatarUrl={channel?.avatar} handle={channel?.name ?? ""} />
    {/if}

    <h4 class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-white text-lg font-bold`}>
      {channel?.name}
    </h4>
  </div>


  {#if !isMobile}
    <div class="flex">
      {@render toolbar()}
    </div>
  {/if}
</header>

{#if space}
  <ChatArea
    source={{ type: "space", space: space }}
    timeline={channel?.timeline ?? []}
  />
  <div class="flex float-end">
    {#if !isMobile || !isThreading.value}
      <section class="grow flex flex-col">
        {#if replyingTo}
          <div
            class="flex justify-between bg-violet-800 text-white rounded-t-lg px-4 py-2"
          >
            <div class="flex flex-col gap-1">
              <h5 class="flex gap-2 items-center">
                Replying to
                <AvatarImage
                  handle={replyingTo.authorProfile.handle}
                  avatarUrl={replyingTo.authorProfile.avatarUrl}
                  className="!w-4"
                />
                <strong>{replyingTo.authorProfile.handle}</strong>
              </h5>
              <p class="text-gray-300 text-ellipsis italic">
                {@html getContentHtml(replyingTo.content)}
              </p>
            </div>
            <Button.Root
              type="button"
              onclick={() => (replyingTo = null)}
              class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
            >
              <Icon icon="zondicons:close-solid" />
            </Button.Root>
          </div>
        {/if}
        <div class="relative">

          <!-- TODO: get all users that has joined the server -->
          <ChatInput 
            bind:content={messageInput} 
            users={users.value}
            context={contextItems.value}
            onEnter={sendMessage}
          />

          <!--
          {#if mayUploadImages}
            <label
              class="cursor-pointer text-white hover:text-gray-300 absolute right-3 top-1/2 -translate-y-1/2"
            >
              <input
                type="file"
                accept="image/*"
                multiple
                class="hidden"
                onchange={handleImageSelect}
              />
              <Icon
                icon="material-symbols:add-photo-alternate"
                class="text-2xl"
              />
            </label>
          {/if}
          -->
        </div>

        <!-- Image preview 
        {#if imageFiles?.length}
          <div class="flex gap-2 flex-wrap">
            {#each Array.from(imageFiles) as file}
              <div class="relative mt-5">
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  class="w-20 h-20 object-cover rounded"
                />
                <button
                  type="button"
                  class="absolute -top-2 -right-2 bg-red-500 rounded-full p-1"
                  onclick={() => (imageFiles = null)}
                >
                  <Icon icon="zondicons:close-solid" color="white" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        -->
      </section>
    {/if}

    {#if isMobile}
      {@render toolbar()}
    {/if}
  </div>
{/if}

{#snippet toolbar()}
  <menu class="relative flex items-center gap-3 px-2 w-fit self-end">
    <Popover.Root>
      <Popover.Trigger onclick={() => isThreading.value = !isThreading.value}>
        <Icon
          icon="tabler:needle-thread"
          color="white"
          class="text-2xl"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content 
          side="left" 
          sideOffset={8} 
          interactOutsideBehavior="ignore" 
          class="text-white bg-violet-900 rounded p-4"
        >
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input type="text" bind:value={threadTitleInput} class="bg-violet-800" placeholder="Thread Title" />
            <button type="submit" class="bg-violet-800 w-full rounded py-2">Create Thread</button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <Button.Root
      title="Copy invite link"
      class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>

    {#if isAdmin}
      <Dialog title="Channel Settings" bind:isDialogOpen={showSettingsDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Channel Settings"
            class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex"
          >
            <Icon icon="lucide:settings" color="white" class="text-2xl" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
          <label>
            Name
            <input
              bind:value={channelNameInput}
              placeholder="channel-name"
              class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
            />
          </label>
          {#if space}
            <select bind:value={channelCategoryInput}>
              <option class="bg-violet-900 text-white" value={undefined}
                >Category: None</option
              >
              {#each Object.keys(space.view.categories) as categoryId}
                {@const category = space.view.categories[categoryId]}
                <option class="bg-violet-900 text-white" value={categoryId}
                  >Category: {category.name}</option
                >
              {/each}
            </select>
          {/if}
          <Button.Root
            class={`px-4 py-2 bg-white text-black rounded-lg disabled:bg-white/50 active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 hover:scale-[102%]`}
          >
            Save Settings
          </Button.Root>
        </form>
      </Dialog>
    {/if}
  </menu>
{/snippet}