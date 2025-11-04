<script lang="ts">
  import { Button, Input, toast } from "@fuxui/base";
  import MessageContext from "./message/MessageContext.svelte";
  import FullscreenImageDropper from "$lib/components/helper/FullscreenImageDropper.svelte";

  import IconMdiCloseCircle from "~icons/mdi/close-circle";
  import IconTablerNeedleThread from "~icons/tabler/needle-thread";
  import IconTablerX from "~icons/tabler/x";
  import UploadFileButton from "$lib/components/helper/UploadFileButton.svelte";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries.svelte";
  import { monotonicFactory } from "ulidx";
  import { page } from "$app/state";
  // import type { Message } from "./ChatArea.svelte";
  // import { setInputFocus } from "./ChatInput.svelte";
  import { navigate } from "$lib/utils.svelte";
  import type { EventType } from "$lib/workers/materializer";
  import {
    setNormal,
    type MessagingState,
    type Threading,
  } from "./TimelineView.svelte";

  // let {
  //   threading = $bindable({ active: false, selectedMessages: [], name: "" }),
  // }: {
  //   threading?: ;
  // } = $props();
  //
  let {
    messagingState = $bindable({
      kind: "normal",
      input: "",
      files: [],
    }),
  }: { messagingState: MessagingState } = $props();

  let messageInputEl: null | HTMLInputElement = $state(null);
  let isSendingMessage = $state(false);

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

  function processImageFile(file: File) {
    if (messagingState.kind === "threading") {
      toast.error("Cannot send files while creating a thread.", {
        position: "bottom-right",
      });
      return;
    }
    messagingState.files.push(file);

    if (file.type.startsWith("video/")) {
      getVideoThumbnail(file).then((thumbnail) => {
        previewImages.push(thumbnail);
      });
    } else {
      previewImages.push(URL.createObjectURL(file));
    }
  }

  function removeImageFile(index: number) {
    if (messagingState.kind === "threading") {
      toast.error(
        "It shouldn't be possible to have (or remove) files while threading...",
        {
          position: "bottom-right",
        },
      );
      return;
    }
    let previewImage = previewImages[index];
    messagingState.files = messagingState.files.filter((_, i) => i !== index);
    previewImages = previewImages.filter((_, i) => i !== index);

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
  }

  async function handleCreateThread() {
    if (!current.space?.id) return;
    if (messagingState.kind !== "threading") return;
    if ((messagingState as Threading).selectedMessages.length == 0) return;
    const ulid = monotonicFactory();
    const threadName =
      messagingState.name ||
      messagingState.selectedMessages[0]?.content.slice(0, 50) + "...";

    const threadId = ulid();
    await backend.sendEvent(current.space.id, {
      ulid: threadId,
      parent: current.roomId,
      variant: {
        kind: "space.roomy.room.create.0",
        data: undefined,
      },
    });

    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: threadId,
      variant: {
        kind: "space.roomy.thread.mark.0",
        data: undefined,
      },
    });

    await backend.sendEvent(current.space.id, {
      ulid: ulid(),
      parent: threadId,
      variant: {
        kind: "space.roomy.info.0",
        data: {
          name: { set: threadName },
          description: { ignore: undefined },
          avatar: { ignore: undefined },
        },
      },
    });

    for (const message of messagingState.selectedMessages) {
      await backend.sendEvent(current.space.id, {
        ulid: ulid(),
        parent: message.id,
        variant: {
          kind: "space.roomy.parent.update.0",
          data: {
            parent: threadId,
          },
        },
      });
    }

    navigate({ space: page.params.space, object: threadId });
  }

  async function sendMessage(e: SubmitEvent) {
    e.preventDefault();
    if (messagingState.kind === "threading") return;
    if (!messagingState.input && messagingState.files.length == 0) return;

    isSendingMessage = true;

    const message = messagingState.input;
    const filesToUpload = [...messagingState.files];
    const replyToId =
      "replyTo" in messagingState ? messagingState.replyTo?.id : undefined;

    console.log("Uploading files:", filesToUpload);

    const uploadedFiles: { uri: string; mimeType: string }[] = [];
    for (const media of filesToUpload) {
      const { uri } = await backend.uploadToPds(await media.arrayBuffer(), {
        mimeType: media.type,
      });
      uploadedFiles.push({ uri, mimeType: media.type });
      console.log("Uploaded file", media);
    }

    if (!current.space) return;
    try {
      const ulid = monotonicFactory();
      const events: EventType[] = [];

      const messageId = ulid();
      events.push({
        ulid: messageId,
        parent: page.params.object,
        variant: {
          kind: "space.roomy.message.create.0",
          data: {
            replyTo: replyToId,
            content: {
              content: new TextEncoder().encode(message),
              mimeType: "text/markdown",
            },
          },
        },
      });

      for (const { uri: uri, mimeType } of uploadedFiles) {
        events.push({
          ulid: ulid(),
          parent: messageId,
          variant: {
            kind: "space.roomy.media.create.0",
            data: {
              uri,
              mimeType,
            },
          },
        });
      }

      await backend.sendEventBatch(current.space.id, events);
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to send message.", { position: "bottom-right" });
    } finally {
      messagingState = { kind: "normal", input: "", files: [] };
      isSendingMessage = false;
      previewImages = [];
    }
  }
</script>

<div
  class="flex-none pt-2 pb-2 pr-2 border-t border-base-100 dark:border-base-900"
>
  <!-- Message context: reply, threading, or comment -->
  <div
    class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"
  >
    {#if messagingState.kind === "replying"}
      <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
        <span class="shrink-0 text-base-900 dark:text-base-100"
          >Replying to</span
        >
        <MessageContext bind:context={messagingState} />
      </div>
      <Button variant="ghost" onclick={() => setNormal()} class="flex-shrink-0">
        <IconMdiCloseCircle />
      </Button>
    {:else if messagingState.kind === "threading"}
      <div
        class="px-2 flex flex-wrap items-center gap-1 overflow-hidden text-xs w-full"
      >
        <span class="shrink-0 text-base-900 dark:text-base-100"
          >Creating thread with</span
        >
        {#if messagingState.selectedMessages[0]}
          <div class="max-w-[28rem]">
            <MessageContext bind:context={messagingState} />
          </div>
        {/if}
        {#if messagingState.selectedMessages.length > 1}
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >and {messagingState.selectedMessages.length - 1} other message{messagingState
              .selectedMessages.length > 2
              ? "s"
              : ""}</span
          >
        {:else if messagingState.selectedMessages.length === 0}
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >no messages</span
          >
        {/if}
      </div>
      <Button variant="ghost" onclick={() => setNormal()} class="flex-shrink-0">
        <IconMdiCloseCircle />
      </Button>
    {:else if messagingState.kind === "commenting"}
      <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
        <MessageContext bind:context={messagingState} />
      </div>
      <Button variant="ghost" onclick={() => setNormal()} class="flex-shrink-0">
        <IconMdiCloseCircle />
      </Button>
    {/if}
  </div>

  <div class="w-full py-1">
    <div class="prose-a:text-primary prose-a:underline relative isolate">
      {#if previewImages.length > 0}
        <div class="flex gap-2 my-2 overflow-x-auto w-full px-2">
          {#each previewImages as previewImage, index (previewImage)}
            <div
              class={[
                "size-24 relative shrink-0",
                isSendingMessage ? "opacity-60" : "",
              ]}
            >
              <img
                src={previewImage}
                alt="Preview"
                class="absolute inset-0 w-full h-full object-cover"
              />

              <Button
                disabled={isSendingMessage}
                variant="ghost"
                class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full disabled:hidden"
                onclick={() => removeImageFile(index)}
              >
                <IconTablerX class="size-4" />
              </Button>
            </div>
          {/each}
        </div>
      {/if}

      <div class="flex w-full pl-2 gap-2">
        {#if messagingState.kind === "threading"}
          <form onsubmit={handleCreateThread} class="flex w-full gap-2">
            <label for="thread-name" class="pl-4 py-2 text-xs font-medium"
              >Thread name (optional):</label
            >
            <Input
              disabled={isSendingMessage}
              bind:value={messagingState.name}
              id="thread-name"
              class="grow ml-2 disabled:opacity-50"
            />

            <Button type="submit"
              ><IconTablerNeedleThread />Create Thread</Button
            >
          </form>
        {:else}
          {#if isSendingMessage}
            <div class="flex items-center justify-center py-2">Sending...</div>
          {:else}
            <UploadFileButton {processImageFile} />
          {/if}

          <form onsubmit={sendMessage} class="w-full">
            <Input
              disabled={isSendingMessage}
              bind:ref={messageInputEl}
              bind:value={messagingState.input}
              placeholder="Send a message..."
              class="w-full font-normal text-base-800 dark:text-base-200 disabled:opacity-50"
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
    </div>
  </div>
</div>
