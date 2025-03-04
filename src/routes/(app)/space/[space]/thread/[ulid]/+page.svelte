<script lang="ts">
  import _ from "underscore";
  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { getContext, setContext } from "svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import { fly } from "svelte/transition";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover, Toggle } from "bits-ui";

  import type {
    Did,
    Space,
    Ulid,
  } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let spaceContext = getContext("space") as { get value(): Autodoc<Space> | undefined };
  let space = $derived(spaceContext.value);
  let thread = $derived(space?.view.threads[page.params.ulid]);
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
      };
      doc.threads[page.params.ulid].timeline.push(id);
    });

    messageInput = {};
    replyingTo = null;
    imageFiles = null;
  }
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" color="white" />
      </Button.Root>
    {:else}
      <AvatarImage handle={thread?.title ?? ""} />
    {/if}

    <h4 class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-white text-lg font-bold`}>
      {thread?.title}
    </h4>
  </div>


  {#if !isMobile}
    <div class="flex">
      {@render toolbar({ growButton: false })}
    </div>
  {/if}
</header>

{#if space}
  <ChatArea
    source={{ type: "space", space: space }}
    timeline={thread?.timeline ?? []}
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
      {@render toolbar({ growButton: true })}
    {/if}
  </div>
{/if}

{#snippet toolbar({ growButton = false }: { growButton: boolean })}
  {#if isThreading.value}
    <div in:fly class={`${growButton && "grow w-full pr-2"}`}>
      <Popover.Root>
        <Popover.Trigger
          class={`cursor-pointer ${growButton ? "w-full" : "w-fit"} px-4 py-2 rounded bg-violet-800 text-white`}
        >
          Create Thread
        </Popover.Trigger>

        <Popover.Content
          sideOffset={8}
          forceMount
          class="bg-violet-800 p-4 rounded"
        >
          <form onsubmit={createThread} class="text-white flex flex-col gap-4">
            <label class="flex flex-col gap-1">
              Thread Title
              <input
                bind:value={threadTitleInput}
                type="text"
                placeholder="Notes"
                class="border px-4 py-2 rounded"
              />
            </label>
            <Popover.Close>
              <button
                type="submit"
                class="text-black px-4 py-2 bg-white rounded w-full text-center"
              >
                Confirm
              </button>
            </Popover.Close>
          </form>
        </Popover.Content>
      </Popover.Root>
    </div>
  {/if}

  <menu class="relative flex items-center gap-3 px-2 w-fit self-end">
    <Toggle.Root
      bind:pressed={isThreading.value}
      class={`p-2 ${isThreading.value && "bg-white/10"} cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 rounded`}
    >
      <Icon
        icon="tabler:needle-thread"
        color="white"
        class="text-2xl"
      />
    </Toggle.Root>
    <Button.Root
      title="Copy invite link"
      class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>
  </menu>
{/snippet}