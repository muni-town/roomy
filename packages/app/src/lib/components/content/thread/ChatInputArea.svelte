<script lang="ts">
  import { toast } from "@foxui/core";
  import MessageContext, {
    type MessageContext as MessageContextType,
  } from "./message/MessageContext.svelte";
  import FullscreenImageDropper from "@roomy/design/components/helper/FullscreenImageDropper.svelte";
  import ChatInputShell, {
    type ChatInputShellMode,
  } from "@roomy/design/components/content/thread/ChatInputShell.svelte";

  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { messagingState, type Commenting } from "./TimelineView.svelte";
  import { markCommentForRemoval } from "@roomy/design/components/richtext/RichTextEditor.svelte";
  import { getImagePreloadData } from "$lib/utils/media";
  import { newUlid, toBytes, Ulid, type Event as RoomyEvent } from "@roomy-space/sdk";
  import type { Attachment } from "@roomy-space/sdk";
  import ChatInput, { clearInput, setInputFocus } from "./ChatInput.svelte";
  import { createThread } from "$lib/mutations/room";
  import { goto } from "$app/navigation";

  let spaceId = $derived(app.joinedSpace?.id);
  let canWrite = $derived(app.canWriteInRoom);
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
      (("input" in messagingState.current && !!messagingState.current.input) ||
        ("files" in messagingState.current &&
          messagingState.current.files.length > 0)),
  );
  let showContextPreview = $derived(
    messagingState.current.kind === "replying" ||
      messagingState.current.kind === "threading" ||
      messagingState.current.kind === "commenting",
  );

  let messageContext = $derived.by((): MessageContextType | null => {
    const state = messagingState.current;
    if (state.kind === "replying") {
      return { kind: "replying", replyTo: state.replyTo };
    } else if (state.kind === "threading") {
      return { kind: "threading", selectedMessages: state.selectedMessages };
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
      };
    }
    return null;
  });

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
    const state = messagingState.current;
    if (state.kind === "commenting") {
      markCommentForRemoval((state as Commenting).comment);
    }
    messagingState.setNormal();
  }

  async function handleCreateThread() {
    if (!spaceId || !app.roomId) return;
    const state = messagingState.current;
    if (state.kind !== "threading") return;
    const threadName = state.name;

    const threadId = await createThread({
      spaceId,
      linkToRoom: app.roomId,
      threadName,
    });

    console.log("created thread", {
      threadId,
      messagesToMove: $state.snapshot(state.selectedMessages),
    });

    const events: RoomyEvent[] = [];

    events.push({
      id: newUlid(),
      room: app.roomId,
      $type: "space.roomy.link.createRoomLink.v0",
      linkToRoom: threadId,
      isCreationLink: true,
    });

    for (const msg of state.selectedMessages) {
      events.push({
        id: newUlid(),
        room: app.roomId,
        $type: "space.roomy.message.moveMessages.v0",
        messageIds: [msg.id],
        toRoomId: threadId,
      });
    }

    console.log("sending thread creation events", { spaceId, events });
    await peer.sendEventBatch(spaceId, events);

    messagingState.set({
      kind: "normal",
      input: "",
      files: [],
    });

    const threadUrl =
      navigateSync({ space: page.params.space, object: threadId }) +
      "?parent=" +
      app.roomId;

    console.log("threadUrl", threadUrl);

    goto(threadUrl);
  }

  async function sendMessage() {
    const state = messagingState.current;

    if (state.kind === "threading") return;
    if (!state.input && state.files.length == 0) return;
    if (!spaceId) return;

    isSendingMessage = true;

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
      name?: string;
    }[] = [];
    for (const media of filesToUpload) {
      console.debug("uploading", media);
      const { cleanedFile, ...dimensions } = await getImagePreloadData(media);
      // For images, cleanedFile has EXIF stripped + orientation applied.
      // For non-images (video, files), use the original file as-is.
      const fileToUpload = cleanedFile ?? media;
      const { uri } = await peer.uploadToPds(await fileToUpload.arrayBuffer(), {
        mimetype: media.type,
      });

      uploadedFiles.push({
        uri,
        mimeType: media.type,
        size: media.size,
        name: media.name,
        ...dimensions,
      });
    }
    if (uploadedFiles.length) console.debug("uploaded", uploadedFiles);

    try {
      const messageId = newUlid();

      const attachments: Attachment[] = uploadedFiles.map((data) => {
        // Use image/video attachment types for media so the materializer
        // stores them in comp_embed_image/_video with full metadata
        // (width/height/blurhash). Files use the generic file attachment.
        if (data.mimeType.startsWith("image/")) {
          return {
            $type: "space.roomy.attachment.image.v0",
            uri: data.uri,
            mimeType: data.mimeType,
            alt: data.alt,
            width: data.width,
            height: data.height,
            size: data.size,
            blurhash: data.blurhash,
          };
        } else if (data.mimeType.startsWith("video/")) {
          return {
            $type: "space.roomy.attachment.video.v0",
            uri: data.uri,
            mimeType: data.mimeType,
            alt: data.alt,
            width: data.width,
            height: data.height,
            size: data.size,
            blurhash: data.blurhash,
          };
        }
        return {
          $type: "space.roomy.attachment.file.v0",
          uri: data.uri,
          mimeType: data.mimeType,
          name: data.name,
          size: data.size,
        };
      });

      if (state.kind === "replying") {
        attachments.push({
          $type: "space.roomy.attachment.reply.v0",
          target: Ulid.assert(state.replyTo.id),
        });
      }

      if (state.kind === "commenting") {
        attachments.push({
          $type: "space.roomy.attachment.comment.v0",
          version: Ulid.assert(state.comment.docVersion),
          snippet: state.comment.snippet || "",
          from: state.comment.from,
          to: state.comment.to,
        });
      }

      const messageEvent: RoomyEvent<"space.roomy.message.createMessage.v0"> = {
        id: messageId,
        room: Ulid.assert(page.params.object),
        $type: "space.roomy.message.createMessage.v0",
        body: {
          data: toBytes(new TextEncoder().encode(message)),
          mimeType: "text/markdown",
        },
        extensions: {
          "space.roomy.extension.attachments.v0": {
            attachments,
          },
        },
      };

      console.debug("sending message", messageEvent);

      await peer.sendEvent(spaceId, messageEvent);
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to send message.", { position: "bottom-right" });
    } finally {
      messagingState.set({ kind: "normal", input: "", files: [] });
      clearInput();
      isSendingMessage = false;
      previewImages = [];
      setInputFocus();
    }
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
  onSend={sendMessage}
  onUploadMedia={handleUploadMedia}
  onCreateThreadFromMenu={handleCreateThreadFromMenu}
  onCreateThread={handleCreateThread}
  onRemoveImage={removeImageFile}
  onThreadNameChange={(name) => (messagingState.name = name)}
  onFileInput={handleFileProcess}
  bindFileInput={(el) => (fileInput = el)}
>
  {#snippet contextPreview()}
    {#if messageContext}
      <MessageContext context={messageContext} />
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
        users={undefined}
        context={undefined}
        onEnter={sendMessage}
        disabled={isSendingMessage}
        {processImageFile}
      />
    {/if}
  {/snippet}
  {#snippet fullscreenDropper()}
    <FullscreenImageDropper {processImageFile} />
  {/snippet}
</ChatInputShell>
