<script lang="ts">
  import { browser } from "$app/environment";
  import FullscreenImageDropper from "@roomy/design/components/helper/FullscreenImageDropper.svelte";
  import ChatInputShell, {
    type ChatInputShellMode,
  } from "@roomy/design/components/content/thread/ChatInputShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { newUlid, toBytes, extractFacetUrls } from "@roomy-space/sdk";
  import type { schemas, Block } from "@roomy-space/sdk";
  import ChatInput, {
    clearInput,
    setInputFocus,
  } from "./ChatInput.svelte";
  import type { Message } from "$lib/queries/messages";
  import { createMentionSearch } from "$lib/tiptap/mentions";
  import { sendMessage as sendMessageMutation } from "$lib/mutations/message";
  import { uploadFile } from "$lib/mutations/upload";
  import { sendEvents } from "$lib/mutations/send-events";
  import { createThread } from "$lib/mutations/thread";
  import MessageContext from "./MessageContext.svelte";
  import LinkCard from "./embeds/LinkCard.svelte";
  import { extractUrls, fetchEmbedData } from "$lib/embed/embed-service";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconX } from "@roomy/design/icons";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

  type Props = {
    spaceId: string;
    roomId: string;
    canWrite: boolean | undefined;
    /**
     * Disable media uploads (image/video). Used for private (invite-only)
     * spaces where private media isn't supported yet. Gates the file
     * picker, paste, and drag-drop entry points.
     */
    disableUploads?: boolean;
    /** Whether to auto-focus the input on mount/tab switch. Default: true */
    autoFocus?: boolean;
    /** Select mode: forward the selected messages (modal owned by the route page). */
    onForwardSelection?: (messages: Message[]) => void;
  };

  let {
    spaceId,
    roomId,
    canWrite,
    disableUploads = false,
    autoFocus = true,
    onForwardSelection,
  }: Props = $props();

  // On mobile (coarse pointer), never autofocus — the virtual keyboard
  // appearing is disruptive. Covers both tab-switch and navigation cases.
  // Computed synchronously (not in onMount) so the value is settled before
  // child ChatInput's onMount runs and triggers focus.
  const isCoarsePointer = browser && matchMedia("(pointer: coarse)").matches;

  // Blocks+facets form of the composer content. Binding happens against a
  // LOCAL mirror: a function-form bind on module-level messagingState state
  // wedges SvelteKit's navigation flush when the keyed ChatInputArea remounts
  // (the bind getter runs mid-navigation; the room switch then never renders).
  // Pull store → local on change; push local edits → store guarded by
  // reference so the pull doesn't echo itself back.
  let blocks: Block[] | undefined = $state();

  $effect(() => {
    blocks = messagingState.blocks;
  });

  $effect(() => {
    if (blocks && blocks !== messagingState.blocks) {
      messagingState.blocks = blocks;
    }
  });

  // ── Client-side link embeds ────────────────────────────────────────────
  // The composer detects the URL being typed, fetches embed metadata directly
  // from the embed service, and shows a preview below the input. The user can
  // dismiss it with the 'x' button. This is composer UX only — the sent
  // message's link card is still enriched server-side by the appserver's
  // sweeper (the client doesn't attach a LinkAttachment, which would create a
  // duplicate embed row).
  let linkEmbed: { url: string; embed: LinkEmbedData | null } | null =
    $state(null);
  /** URL the user explicitly dismissed — don't re-fetch/re-show it. */
  let dismissedUrl: string | null = $state(null);

  // The first URL currently present in the composer (rich-text link facets
  // when the new schema is active, else a regex scan of the markdown).
  const composedUrl = $derived(
    messagingState.blocks && messagingState.blocks.length > 0
      ? extractFacetUrls(messagingState.blocks)[0] ?? null
      : extractUrls(messagingState.input)[0] ?? null,
  );

  // Reset the dismissal whenever the composed URL changes, so a fresh
  // composition of the same URL can show the preview again.
  $effect(() => {
    if (dismissedUrl && dismissedUrl !== composedUrl) {
      dismissedUrl = null;
    }
  });

  // Fetch embed data for the composed URL and keep the preview in sync.
  //
  // Uses a NON-reactive `embedFetchUrl` guard rather than reading `linkEmbed`
  // back here. If the effect read `linkEmbed` to decide whether to refetch,
  // then writing `linkEmbed = { url, embed: null }` inside it would re-trigger
  // the effect, whose cleanup would set `cancelled = true` and DISCARD the
  // resolved embed (leaving an empty preview box even though the request
  // succeeded). Tracking the in-flight URL in a plain variable avoids that
  // self-cancel entirely.
  let embedFetchUrl: string | null = null;
  $effect(() => {
    const url = composedUrl;
    if (!url) {
      linkEmbed = null;
      embedFetchUrl = null;
      return;
    }
    if (dismissedUrl === url) return;
    if (embedFetchUrl === url) return;
    embedFetchUrl = url;
    linkEmbed = { url, embed: null };
    fetchEmbedData(url).then((embed) => {
      if (embedFetchUrl === url) linkEmbed = { url, embed };
    });
  });

  function dismissLinkEmbed() {
    dismissedUrl = linkEmbed?.url ?? null;
    linkEmbed = null;
  }


  let isSendingMessage = $state(false);

  let shouldFocus = $derived(autoFocus && !isCoarsePointer && !isSendingMessage && messagingState.previewImages.length === 0);

  // Server-side member search for `@mention` in the chat input. Empty query →
  // recent-active preseed; non-empty → `getMembers?search=` on the appserver.
  // Shared with the edit-message editor and forward composer (see
  // `$lib/tiptap/mentions.ts`).
  const mentionSearch = createMentionSearch(spaceId, roomId);

  // Activate this room's composer document BEFORE this component's subtree
  // (re)mounts, so the ChatInput editor seeds from the recalled per-room
  // draft (`{#key roomId}` remounts on room change). Pre-effects run ahead of
  // this component's own DOM update, which precedes the ChatInput mount.
  $effect.pre(() => {
    messagingState.setActiveRoom(roomId);
  });

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
  // Selecting mode uses the same selected-message count, shown as "N selected".
  let selectedCount = $derived(
    messagingState.current.kind === "selecting"
      ? messagingState.current.selectedMessages.length
      : 0,
  );
  let canSend = $derived(
    messagingState.current.kind !== "threading" &&
      messagingState.current.kind !== "selecting" &&
      (("input" in messagingState.current &&
        !!messagingState.current.input) ||
        ("files" in messagingState.current &&
          messagingState.current.files.length > 0)),
  );
  let showContextPreview = $derived(
    messagingState.current.kind === "replying" ||
      messagingState.current.kind === "threading" ||
      messagingState.current.kind === "selecting",
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
    if (disableUploads) return;
    if (
      messagingState.current.kind === "threading" ||
      messagingState.current.kind === "selecting"
    )
      return;
    messagingState.addFile(file);

    // Preview URLs are stored on this room's draft (not the active one) so an
    // async video thumbnail resolving after a room switch lands correctly.
    if (file.type.startsWith("video/")) {
      getVideoThumbnail(file).then((thumbnail) => {
        messagingState.addPreviewImage(roomId, thumbnail);
      });
    } else {
      messagingState.addPreviewImage(roomId, URL.createObjectURL(file));
    }
  }

  function removeImageFile(index: number) {
    const previewImage = messagingState.previewImages[index];
    messagingState.removeFile(index);
    messagingState.previewImages = messagingState.previewImages.filter(
      (_, i) => i !== index,
    );
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
    if (disableUploads) return;
    fileInput?.click();
  }

  function handleCreateThreadFromMenu() {
    messagingState.startSelectMode();
    actionMenuOpen = false;
  }

  function handleForwardSelection() {
    if (messagingState.current.kind !== "selecting") return;
    onForwardSelection?.(messagingState.current.selectedMessages);
  }

  function handleSelectCreateThread() {
    if (messagingState.current.kind !== "selecting") return;
    messagingState.setThreadingFromMessages(
      messagingState.current.selectedMessages,
    );
  }

  function handleClearContext() {
    messagingState.setNormal();
  }

  async function handleSend(_message = "", mentions: string[] = [], submittedBlocks: Block[] = []) {
    const state = messagingState.current;
    if (state.kind === "threading" || state.kind === "selecting") return;
    if (!("input" in state)) return;
    if (!state.input && state.files.length === 0) return;

    isSendingMessage = true;

    const message = state.input;
    const filesToUpload = [...state.files];

    // New-format send path: when the composer produced blocks, the wire body
    // is serializeBlocks(blocks) and the mentions sidecar is dropped (mentions
    // fold into `#didMention` facets). When blocks are absent, the legacy
    // markdown path is used.
    const useRichText = !!submittedBlocks && submittedBlocks.length > 0;

    try {
      const attachments: Record<string, unknown>[] = [];

      // Upload media files. Tag by MIME kind so the materializer routes
      // images → comp_embed_image and videos → comp_embed_video (a file.v0
      // tag would land them in comp_embed_file with no image metadata).
      for (const file of filesToUpload) {
        const uploaded = await uploadFile(file);
        const base = { uri: uploaded.uri, mimeType: uploaded.mimeType, size: uploaded.size };
        if (file.type.startsWith("image/")) {
          attachments.push({ $type: "space.roomy.attachment.image.v0", ...base });
        } else if (file.type.startsWith("video/")) {
          attachments.push({ $type: "space.roomy.attachment.video.v0", ...base });
        } else {
          attachments.push({ $type: "space.roomy.attachment.file.v0", ...base, name: file.name });
        }
      }

      // Reply attachment
      if (state.kind === "replying" && state.replyTo) {
        attachments.push({
          $type: "space.roomy.attachment.reply.v0",
          target: state.replyTo.id,
        });
      }

      // Build mentions extension if any DIDs were mentioned (legacy path
      // only — the new format folds mentions into `#didMention` facets).
      const mentionsExt = !useRichText && mentions.length > 0
        ? { "space.roomy.extension.mentions.v0": { $type: "space.roomy.extension.mentions.v0", mentions } }
        : undefined;

      // If we have attachments, send with extensions; otherwise use the simple path
      if (attachments.length > 0) {
        const id = newUlid();
        const extensions: Record<string, unknown> = {
          "space.roomy.extension.attachments.v0": { attachments },
        };
        if (mentionsExt) Object.assign(extensions, mentionsExt);
        const event: Record<string, unknown> = {
          id,
          room: roomId,
          $type: "space.roomy.message.createMessage.v0",
          body: useRichText
            ? {
                mimeType: "application/vnd.roomy.richtext+json",
                data: toBytes(new TextEncoder().encode(JSON.stringify({
                  $type: "space.roomy.richtext.document",
                  blocks: submittedBlocks,
                }))),
              }
            : {
                mimeType: "text/markdown",
                data: toBytes(new TextEncoder().encode(message)),
              },
          extensions,
        };
        await sendEvents(spaceId, [event]);
      } else {
        await sendMessageMutation(spaceId, roomId, message, {
          replyTo:
            state.kind === "replying" ? state.replyTo.id : undefined,
          mentions,
          ...(useRichText ? { blocks: submittedBlocks } : {}),
        });
      }
    } catch (e: unknown) {
      console.error("Failed to send message:", e);
    } finally {
      messagingState.set({ kind: "normal", input: "", files: [], blocks: [], mentions: [], previewImages: [] });
      clearInput();
      isSendingMessage = false;
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

    messagingState.set({ kind: "normal", input: "", files: [], blocks: [], mentions: [], previewImages: [] });
    clearInput();

    goto(`/${page.params.space}/${threadId}?parent=${roomId}`);
  }
</script>

<ChatInputShell
  {canWrite}
  {isSendingMessage}
  previewImages={messagingState.previewImages}
  mode={shellMode}
  {actionMenuOpen}
  {disableUploads}
  onActionMenuOpenChange={(o) => (actionMenuOpen = o)}
  {threadName}
  {threadSelectedCount}
  {selectedCount}
  {canSend}
  {showContextPreview}
  onClearContext={handleClearContext}
  onSend={handleSend}
  onUploadMedia={handleUploadMedia}
  onCreateThreadFromMenu={handleCreateThreadFromMenu}
  onCreateThread={handleCreateThread}
  onForwardSelection={handleForwardSelection}
  onSelectCreateThread={handleSelectCreateThread}
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
    {:else if messagingState.current.kind === "selecting"}
      <!-- Preview of the first selected message, same form as the thread
           creation strip. -->
      <MessageContext context={{ kind: "threading", selectedMessages: messagingState.current.selectedMessages }} roomId={roomId} />
    {/if}
  {/snippet}
  {#snippet input()}
    {#if messagingState.current.kind === "normal" || messagingState.current.kind === "replying"}
      <ChatInput
        composer
        bind:content={
          () =>
            "input" in messagingState.current ? messagingState.current.input : "",
          (v) => {
            if ("input" in messagingState.current) {
              messagingState.input = v;
            }
          }
        }
        bind:blocks
        initialBlocks={messagingState.blocks}
        onEnter={handleSend}
        disabled={isSendingMessage}
        setFocus={shouldFocus}
        processImageFile={disableUploads ? undefined : processImageFile}
        mentionSearch={mentionSearch}
      />
    {/if}
  {/snippet}
  {#snippet linkEmbedPreview()}
    {#if linkEmbed}
      <div class="relative">
        <LinkCard url={linkEmbed.url} embed={linkEmbed.embed} />
        <Button
          variant="ghost"
          class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full"
          aria-label="Dismiss link preview"
          title="Remove link preview"
          onclick={dismissLinkEmbed}
        >
          <IconX class="size-4" />
        </Button>
      </div>
    {/if}
  {/snippet}
  {#snippet fullscreenDropper()}
    {#if !disableUploads}
      <FullscreenImageDropper {processImageFile} />
    {/if}
  {/snippet}
</ChatInputShell>
