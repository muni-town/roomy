<script module lang="ts">
  let replyTo: Message | null = $state(null);

  export function setReplyTo(message: Message) {
    replyTo = message;
    setInputFocus();
  }
</script>

<script lang="ts">
  import { Button, Input, toast } from "@fuxui/base";
  import MessageRepliedTo from "./message/MessageRepliedTo.svelte";
  import FullscreenImageDropper from "$lib/components/helper/FullscreenImageDropper.svelte";

  import IconMdiCloseCircle from "~icons/mdi/close-circle";
  import IconTablerNeedleThread from "~icons/tabler/needle-thread";
  import IconTablerX from "~icons/tabler/x";
  import UploadFileButton from "$lib/components/helper/UploadFileButton.svelte";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries.svelte";
  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import type { Message } from "./ChatArea.svelte";
  import { setInputFocus } from "./ChatInput.svelte";

  let {
    threading = { active: false, selectedMessages: [], name: "" },
  }: {
    threading?: { active: boolean; selectedMessages: Message[]; name: string };
  } = $props();

  let previewImages: string[] = $state([]);

  function getVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = URL.createObjectURL(file);
      video.crossOrigin = "anonymous";
      video.muted = true; // required for autoplay
      video.currentTime = 0;

      video.addEventListener("loadeddata", () => {
        // Wait until some data is loaded so we can capture a frame
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth / 2; // scale it down
        canvas.height = video.videoHeight / 2;

        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas context not available"));

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob)
            return reject(new Error("Failed to create thumbnail blob"));
          const url = URL.createObjectURL(blob);
          resolve(url);
        }, "image/jpeg");
      });

      video.addEventListener("error", reject);
    });
  }

  let filesInMessage: File[] = $state([]);

  // let filesUrls: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[] = [];

  function processImageFile(file: File) {
    filesInMessage.push(file);

    if (file.type.startsWith("video/")) {
      getVideoThumbnail(file).then((thumbnail) => {
        previewImages.push(thumbnail);
      });
    } else {
      previewImages.push(URL.createObjectURL(file));
    }
  }

  function removeImageFile(index: number) {
    let previewImage = previewImages[index];
    filesInMessage = filesInMessage.filter((_, i) => i !== index);
    previewImages = previewImages.filter((_, i) => i !== index);

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
  }

  function handleCreateThread() {
    // TODO
  }

  let messageInput: string = $state("");
  let messageInputEl: null | HTMLInputElement = $state(null);
  let isSendingMessage = $state(false);
  async function sendMessage() {
    if (!current.space) return;
    try {
      isSendingMessage = true;

      await backend.sendEvent(current.space.id, {
        ulid: ulid(),
        parent: page.params.object,
        variant: {
          kind: "space.roomy.message.create.0",
          data: {
            replyTo: replyTo ? replyTo.id : undefined,
            content: {
              content: new TextEncoder().encode(messageInput),
              mimeType: "text/markdown",
            },
          },
        },
      });

      replyTo = null;
      messageInput = "";
      messageInputEl?.focus();
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to send message.", { position: "bottom-right" });
    } finally {
      isSendingMessage = false;
    }
  }
</script>

<div
  class="flex-none bg-white dark:bg-base-950 pt-2 pb-2 pr-2 border-t border-base-100 dark:border-base-900"
>
  {#if replyTo}
    <div
      class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"
    >
      <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
        <span class="shrink-0 text-base-900 dark:text-base-100"
          >Replying to</span
        >
        <MessageRepliedTo message={replyTo} />
      </div>
      <Button
        variant="ghost"
        onclick={() => (replyTo = null)}
        class="flex-shrink-0"
      >
        <IconMdiCloseCircle />
      </Button>
    </div>
  {/if}
  {#if threading.active}
    <div
      class="flex items-start justify-between bg-secondary text-secondary-content rounded-t-lg px-2 py-2"
    >
      <div
        class="px-2 flex flex-wrap items-center gap-1 overflow-hidden text-xs w-full"
      >
        <span class="shrink-0 text-base-900 dark:text-base-100"
          >Creating thread with</span
        >
        {#if threading.selectedMessages[0]}
          <div class="max-w-[28rem]">
            <MessageRepliedTo message={threading.selectedMessages[0]} />
          </div>
        {/if}
        {#if threading.selectedMessages.length > 1}
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >and {threading.selectedMessages.length - 1} other message{threading
              .selectedMessages.length > 2
              ? "s"
              : ""}</span
          >
        {:else if threading.selectedMessages.length === 0}
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >no messages</span
          >
        {/if}
      </div>
      <Button
        variant="ghost"
        onclick={() => {
          threading.active = false;
          threading.selectedMessages = [];
        }}
        class="flex-shrink-0"
      >
        <IconMdiCloseCircle />
      </Button>
    </div>
    <label for="thread-name" class="px-4 py-2 text-xs font-medium"
      >Thread name (optional):</label
    >
  {/if}
  <div class="w-full py-1">
    <div class="prose-a:text-primary prose-a:underline relative isolate">
      {#if previewImages.length > 0}
        <div class="flex gap-2 my-2 overflow-x-auto w-full px-2">
          {#each previewImages as previewImage, index (previewImage)}
            <div class="size-24 relative shrink-0">
              <img
                src={previewImage}
                alt="Preview"
                class="absolute inset-0 w-full h-full object-cover"
              />

              <Button
                variant="ghost"
                class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full"
                onclick={() => removeImageFile(index)}
              >
                <IconTablerX class="size-4" />
              </Button>
            </div>
          {/each}
        </div>
      {/if}

      <div class="flex w-full pl-2 gap-2">
        {#if threading.active}
          <form onsubmit={handleCreateThread}>
            <Input
              bind:value={threading.name}
              id="thread-name"
              class="grow ml-2"
            />
            <Button type="submit"
              ><IconTablerNeedleThread />Create
              <span class="hidden sm:inline-block sm:-ml-1">Thread</span
              ></Button
            >
          </form>
        {:else}
          <UploadFileButton {processImageFile} />
          <form onsubmit={sendMessage} class="w-full">
            <Input
              bind:ref={messageInputEl}
              bind:value={messageInput}
              placeholder="Send a message..."
              class="w-full"
            />
          </form>
          <!-- {#key users.length + context.length} -->
          <!-- <ChatInput
              bind:content={messageInput}
              {users}
              {context}
              onEnter={sendMessage}
              {processImageFile}
            /> -->
          <!-- {/key} -->
        {/if}
      </div>
      <FullscreenImageDropper {processImageFile} />

      {#if isSendingMessage}
        <div
          class="absolute inset-0 flex items-center text-primary justify-center z-20 bg-base-100/80 dark:bg-base-900/80"
        >
          <div
            class="text-xl flex items-center gap-4 text-base-900 dark:text-base-100"
          >
            Sending message...
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
