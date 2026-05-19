<script lang="ts">
  import FullscreenImageDropper from "@roomy/design/components/helper/FullscreenImageDropper.svelte";
  import ChatInputShell, {
    type ChatInputShellMode,
  } from "@roomy/design/components/content/thread/ChatInputShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { newUlid, toBytes } from "@roomy-space/sdk";
  import ChatInput, {
    clearInput,
    setInputFocus,
  } from "./ChatInput.svelte";
  import { sendMessage as sendMessageMutation } from "$lib/mutations/message";
  import { uploadFile } from "$lib/mutations/upload";
  import { sendEvents } from "$lib/mutations/send-events";
  import { createThread } from "$lib/mutations/thread";
  import MessageContext from "./MessageContext.svelte";

  type Props = {
    spaceId: string;
    roomId: string;
    canWrite: boolean;
  };

  let { spaceId, roomId, canWrite }: Props = $props();

  let isSendingMessage = $state(false);
  let previewImages: string[] = $state([]);
  let fileInput: HTMLInputElement | undefined = $state();
  let actionMenuOpen = $state(false);

  let stateKind = $derived(messagingState.current.kind);
  let shellMode = $derived(stateKind as ChatInputShellMode);
  let threadName = $derived(
    messagingState.current.kind === "threading"
      ? messagingState.current.name
      : "",
  );
  let threadSelectedCount = $derived(
    messagingState.current.kind === "threading"
      ? messagingState.current.selectedMessages.length
      : 0,
  );
  let canSend = $derived(
    messagingState.current.kind !== "threading" &&
      (("input" in messagingState.current &&
        !!messagingState.current.input) ||
        ("files" in messagingState.current &&
          messagingState.current.files.length > 0)),
  );
  let showContextPreview = $derived(
    messagingState.current.kind === "replying" ||
      messagingState.current.kind === "threading",
  );

  function getVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = URL.createObjectURL(file);
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.currentTime = 0;

      video.addEventListener("loadeddata", () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth / 2;
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
    if (messagingState.current.kind === "threading") return;
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
    const previewImage = previewImages[index];
    messagingState.removeFile(index);
    previewImages = previewImages.filter((_, i) => i !== index);
    if (previewImage) URL.revokeObjectURL(previewImage);
  }

  function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    for (const file of input.files) {
      if (!file?.type.startsWith("image/") && !file?.type.startsWith("video/"))
        continue;
      processImageFile(file);
    }
    actionMenuOpen = false;
  }

  function handleUploadMedia() {
    fileInput?.click();
  }

  function handleCreateThreadFromMenu() {
    messagingState.startThreading();
    actionMenuOpen = false;
  }

  function handleClearContext() {
    messagingState.setNormal();
  }

  async function handleSend() {
    const state = messagingState.current;
    if (state.kind === "threading") return;
    if (!("input" in state)) return;
    if (!state.input && state.files.length === 0) return;

    isSendingMessage = true;

    const message = state.input;
    const filesToUpload = [...state.files];

    try {
      const attachments: Record<string, unknown>[] = [];

      // Upload media files
      for (const file of filesToUpload) {
        const uploaded = await uploadFile(file);
        attachments.push({
          $type: "space.roomy.attachment.file.v0",
          uri: uploaded.uri,
          mimeType: uploaded.mimeType,
          size: uploaded.size,
        });
      }

      // Reply attachment
      if (state.kind === "replying" && state.replyTo) {
        attachments.push({
          $type: "space.roomy.attachment.reply.v0",
          target: state.replyTo.id,
        });
      }

      // If we have attachments, send with extensions; otherwise use the simple path
      if (attachments.length > 0) {
        const id = newUlid();
        const event: Record<string, unknown> = {
          id,
          room: roomId,
          $type: "space.roomy.message.createMessage.v0",
          body: {
            mimeType: "text/markdown",
            data: toBytes(new TextEncoder().encode(message)),
          },
          extensions: {
            "space.roomy.extension.attachments.v0": { attachments },
          },
        };
        await sendEvents(spaceId, [event]);
      } else {
        await sendMessageMutation(spaceId, roomId, message, {
          replyTo:
            state.kind === "replying" ? state.replyTo.id : undefined,
        });
      }
    } catch (e: unknown) {
      console.error("Failed to send message:", e);
    } finally {
      messagingState.set({ kind: "normal", input: "", files: [] });
      clearInput();
      isSendingMessage = false;
      previewImages = [];
      setInputFocus();
    }
  }

  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Thread creation
  async function handleCreateThread() {
    const state = messagingState.current;
    if (state.kind !== "threading") return;

    const name = state.name;
    const selectedIds = state.selectedMessages.map((m) => m.id);

    const threadId = await createThread({
      spaceId,
      parentRoomId: roomId,
      threadName: name,
      messageIds: selectedIds,
    });

    messagingState.set({ kind: "normal", input: "", files: [] });
    clearInput();

    goto(`/${page.params.space}/${threadId}?parent=${roomId}`);
  }
</script>

<ChatInputShell
  {canWrite}
  {isSendingMessage}
  {previewImages}
  mode={shellMode}
  {actionMenuOpen}
  onActionMenuOpenChange={(o) => (actionMenuOpen = o)}
  {threadName}
  {threadSelectedCount}
  {canSend}
  {showContextPreview}
  onClearContext={handleClearContext}
  onSend={handleSend}
  onUploadMedia={handleUploadMedia}
  onCreateThreadFromMenu={handleCreateThreadFromMenu}
  onCreateThread={handleCreateThread}
  onRemoveImage={removeImageFile}
  onThreadNameChange={(name) => (messagingState.name = name)}
  onFileInput={handleFileProcess}
  bindFileInput={(el) => (fileInput = el)}
>
  {#snippet contextPreview()}
    {#if messagingState.current.kind === "replying"}
      <MessageContext context={{ kind: "replying", replyTo: { id: messagingState.current.replyTo.id } }} roomId={roomId} />
    {:else if messagingState.current.kind === "threading"}
      <MessageContext context={{ kind: "threading", selectedMessages: messagingState.current.selectedMessages }} roomId={roomId} />
    {/if}
  {/snippet}
  {#snippet input()}
    {#if messagingState.current.kind !== "threading"}
      <ChatInput
        bind:content={
          () =>
            "input" in messagingState.current ? messagingState.current.input : "",
          (v) => {
            if ("input" in messagingState.current) {
              messagingState.input = v;
            }
          }
        }
        onEnter={handleSend}
        disabled={isSendingMessage}
        {processImageFile}
      />
    {/if}
  {/snippet}
  {#snippet fullscreenDropper()}
    <FullscreenImageDropper {processImageFile} />
  {/snippet}
</ChatInputShell>
