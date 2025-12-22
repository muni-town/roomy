<script lang="ts">
  import { Button, Input, toast } from "@fuxui/base";
  import MessageContext, {
    type MessageContext as MessageContextType,
  } from "./message/MessageContext.svelte";
  import FullscreenImageDropper from "$lib/components/helper/FullscreenImageDropper.svelte";

  import IconMdiCloseCircle from "~icons/mdi/close-circle";
  import IconTablerNeedleThread from "~icons/tabler/needle-thread";
  import IconTablerX from "~icons/tabler/x";
  import UploadFileButton from "$lib/components/helper/UploadFileButton.svelte";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries";
  import { page } from "$app/state";
  import { navigate } from "$lib/utils.svelte";
  import {
    messagingState,
    type Commenting,
    type Threading,
  } from "./TimelineView.svelte";
  import { markCommentForRemoval } from "$lib/components/richtext/RichTextEditor.svelte";
  import { getImagePreloadData } from "$lib/utils/media";
  import { newUlid, toBytes, Ulid, type Event } from "$lib/schema";
  import type { MessageExtension } from "$lib/schema/extensions/message";
  import ChatInput, { setInputFocus } from "./ChatInput.svelte";
  import { createRoom } from "$lib/mutations/room";

  let spaceId = $derived(current.joinedSpace?.id);
  let isSendingMessage = $state(false);
  let previewImages: string[] = $state([]);

  $effect(() => {
    console.log("messaging state", messagingState.current);
  });

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
    if (messagingState.current.kind === "threading") {
      toast.error("Cannot send files while creating a thread.", {
        position: "bottom-right",
      });
      return;
    }
    messagingState.addFile(file);

    if (file.type.startsWith("video/")) {
      getVideoThumbnail(file).then((thumbnail) => {
        previewImages.push(thumbnail);
      });
    } else {
      previewImages.push(URL.createObjectURL(file));
    }
  }

  function removeImageFile(index: number) {
    if (messagingState.current.kind === "threading") {
      toast.error(
        "It shouldn't be possible to have (or remove) files while threading...",
        {
          position: "bottom-right",
        },
      );
      return;
    }
    let previewImage = previewImages[index];
    messagingState.removeFile(index);
    previewImages = previewImages.filter((_, i) => i !== index);

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
  }

  /** Needs to be called in an anonymous function to preserve messagingStateManager.this binding
   * see https://svelte.dev/docs/svelte/$state#Classes
   */
  async function handleCreateThread() {
    if (!spaceId) return;
    const state = messagingState.current;
    if (state.kind !== "threading") return;
    if ((state as Threading).selectedMessages.length == 0) return;
    const threadName =
      state.name || state.selectedMessages[0]?.content.slice(0, 50) + "...";

    const threadId = await createRoom({
      spaceId,
      parentRoomId: current.roomId,
      kind: "thread",
      info: {
        name: threadName,
      },
    });

    // move selected messages into thread
    for (const message of state.selectedMessages) {
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        room: message.id,
        variant: {
          $type: "space.roomy.room.updateParent.v0",
          parent: threadId,
        },
      });
    }

    messagingState.set({
      kind: "normal",
      input: "",
      files: [],
    });

    navigate({ space: page.params.space, object: threadId });
  }

  async function sendMessage() {
    const state = messagingState.current;

    if (state.kind === "threading") return;
    if (!state.input && state.files.length == 0) return;
    if (!spaceId) return;

    isSendingMessage = true;

    console.log("sending with messaging state", state);

    const message = state.input;
    const filesToUpload = [...state.files];

    const uploadedFiles: {
      uri: string;
      mimeType: string;
      alt?: string;
      height?: number;
      width?: number;
      size: number;
      blurhash?: string;
    }[] = [];
    for (const media of filesToUpload) {
      console.log("uploading", media);
      const { cleanedFile, ...dimensions } = await getImagePreloadData(media);
      if (!cleanedFile)
        throw new Error("Could not strip EXIF metadata for " + media.name);
      const { uri } = await backend.uploadToPds(
        await cleanedFile.arrayBuffer(),
        {
          mimetype: media.type,
        },
      );

      uploadedFiles.push({
        uri,
        mimeType: media.type,
        size: media.size,
        ...dimensions,
      });
    }
    console.log("uploaded", uploadedFiles);

    try {
      const messageId = newUlid();

      const extensions: MessageExtension[] = uploadedFiles.map((data) => ({
        $type: "space.roomy.extension.image.v0",
        uri: data.uri,
        mimeType: data.mimeType,
        alt: data.alt,
        width: data.width,
        height: data.height,
        size: data.size,
        blurhash: data.blurhash,
      }));

      if (state.kind === "replying") {
        extensions.push({
          $type: "space.roomy.extension.replyTo.v0",
          target: Ulid.assert(state.replyTo.id),
        });
      }

      if (state.kind === "commenting") {
        extensions.push({
          $type: "space.roomy.extension.comment.v0",
          version: Ulid.assert(state.comment.docVersion),
          snippet: state.comment.snippet || "",
          from: state.comment.from,
          to: state.comment.to,
        });
      }

      const messageEvent: Event<"space.roomy.room.sendMessage.v1"> = {
        id: messageId,
        room: Ulid.assert(page.params.object),
        variant: {
          $type: "space.roomy.room.sendMessage.v1",
          body: {
            data: toBytes(new TextEncoder().encode(message)),
            mimeType: "text/markdown",
          },
          extensions,
        },
      };

      console.log("sending message", messageEvent);

      await backend.sendEvent(spaceId, messageEvent);
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to send message.", { position: "bottom-right" });
    } finally {
      messagingState.set({ kind: "normal", input: "", files: [] });
      isSendingMessage = false;
      previewImages = [];
      setInputFocus();
    }
  }
</script>

{#snippet messagingStateContext()}
  {@const state = messagingState.current}
  {@const messageContext = (() => {
    if (state.kind === "replying") {
      return {
        kind: "replying",
        replyTo: state.replyTo,
      } satisfies MessageContextType;
    } else if (state.kind === "threading") {
      return {
        kind: "threading",
        selectedMessages: state.selectedMessages,
      } satisfies MessageContextType;
    } else if (state.kind === "commenting") {
      return {
        kind: "commenting",
        messageId: undefined,
        comment: {
          snippet: state.comment.snippet,
          version: state.comment.docVersion,
          from: state.comment.from,
          to: state.comment.to,
        },
      } satisfies MessageContextType;
    }
    return null;
  })()}
  <div
    class="flex-none pt-2 pb-2 pr-2 border-t border-base-100 dark:border-base-900"
  >
    <!-- Message context: reply, threading, or comment -->
    <div
      class="flex justify-between bg-secondary text-secondary-content rounded-t-lg p-2 gap-2 pr-0"
    >
      {#if state.kind === "replying" && messageContext}
        <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
          <MessageContext context={messageContext} />
        </div>
        <Button
          variant="ghost"
          onclick={() => messagingState.setNormal()}
          class="flex-shrink-0"
        >
          <IconMdiCloseCircle />
        </Button>
      {:else if state.kind === "threading" && messageContext}
        <div
          class="px-2 flex flex-wrap items-center gap-1 overflow-hidden text-xs w-full"
        >
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >Creating thread with</span
          >
          {#if state.selectedMessages[0]}
            <div class="max-w-[28rem]">
              <MessageContext context={messageContext} />
            </div>
          {/if}
          {#if state.selectedMessages.length > 1}
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >and {state.selectedMessages.length - 1} other message{state
                .selectedMessages.length > 2
                ? "s"
                : ""}</span
            >
          {:else if state.selectedMessages.length === 0}
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >no messages</span
            >
          {/if}
        </div>
        <Button
          variant="ghost"
          onclick={() => messagingState.setNormal()}
          class="flex-shrink-0"
        >
          <IconMdiCloseCircle />
        </Button>
      {:else if state.kind === "commenting" && messageContext}
        <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
          <MessageContext context={messageContext} />
        </div>
        <Button
          variant="ghost"
          onclick={() => {
            markCommentForRemoval((state as Commenting).comment);
            messagingState.setNormal();
          }}
          class="flex-shrink-0"
        >
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

        <div class="flex w-full gap-2">
          {#if state.kind === "threading"}
            <form
              onsubmit={() => handleCreateThread()}
              class="flex w-full gap-2"
            >
              <label for="thread-name" class="pl-4 py-2 text-xs font-medium"
                >Thread name:</label
              >
              <Input
                disabled={isSendingMessage}
                value={state.name}
                oninput={(e) => (messagingState.name = e.currentTarget.value)}
                id="thread-name"
                class="grow ml-2 disabled:opacity-50"
              />

              <Button type="submit"
                ><IconTablerNeedleThread />Create Thread</Button
              >
            </form>
          {:else}
            {#if isSendingMessage}
              <div class="flex items-center justify-center py-2">
                Sending...
              </div>
            {:else}
              <UploadFileButton {processImageFile} />
            {/if}

            <!-- {#key users.length + context.length} TODO: get users + context to pass in -->
            <ChatInput
              bind:content={state.input}
              users={undefined}
              context={undefined}
              onEnter={sendMessage}
              {processImageFile}
            />
            <!-- {/key} -->
          {/if}
        </div>
        <FullscreenImageDropper {processImageFile} />
      </div>
    </div>
  </div>
{/snippet}

{@render messagingStateContext()}
