<script lang="ts">
  import { browser } from "$app/environment";
  import FullscreenImageDropper from "@roomy/design/components/helper/FullscreenImageDropper.svelte";
  import ChatInputShell, {
    type ChatInputShellMode,
  } from "@roomy/design/components/content/thread/ChatInputShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { extractFacetUrls } from "@roomy-space/sdk";
  import type { schemas, Block } from "@roomy-space/sdk";
  import ChatInput, {
    clearInput,
    setInputFocus,
  } from "./ChatInput.svelte";
  import type { Message } from "$lib/queries/messages";
  import { createMentionSearch } from "$lib/tiptap/mentions";
  import { sendMessage as sendMessageMutation } from "$lib/mutations/message";
  import { uploadFile } from "$lib/mutations/upload";
  import { createThread } from "$lib/mutations/thread";
  import MessageContext from "./MessageContext.svelte";
  import LinkCard from "@roomy/design/components/content/thread/message/embeds/LinkCard.svelte";
  import { extractUrls, fetchEmbedData } from "$lib/embed/embed-service";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { scheduleAutoReload } from "$lib/error-recovery";
  import { toast } from "@foxui/core";
  import { IconX } from "@roomy/design/icons";

  type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

  /** Instance API exported by `ChatInput.svelte` (`<script module>` + instance exports). */
  type ChatInputInstance = {
    submit: () => Promise<void>;
  };

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
    /**
     * Select mode: move the selected messages to another room (modal owned by
     * the route page). Admin-only — the route page passes this only when the
     * viewer is a space admin, which is also what renders the Move button.
     */
    onMoveSelection?: (messages: Message[]) => void;
    /**
     * Select mode: delete the selected messages (confirm dialog owned by the
     * route page). Admin-only — the route page passes this only when the
     * viewer is a space admin, which is also what renders the Delete button.
     */
    onDeleteSelection?: (messages: Message[]) => void;
  };

  let {
    spaceId,
    roomId,
    canWrite,
    disableUploads = false,
    autoFocus = true,
    onForwardSelection,
    onMoveSelection,
    onDeleteSelection,
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

  /**
   * Thread creation in flight. Separate from `isSendingMessage` because the
   * two flags are set by different paths, but they are mutually exclusive in
   * this UI (thread creation is only reachable from `threading` mode, the
   * composer only from `normal` / `replying`), so the shell receives their
   * disjunction as a single `isSendingMessage` prop rather than a second
   * parallel "busy" prop.
   *
   * A large selection is a multi-second round trip: `createThread` creates the
   * room, then forwards every selected message in one `sendEvents` batch. With
   * no in-flight guard the submit stays live for that whole window and a
   * second press creates a second thread (and a second, differently-ordered
   * set of forwards).
   */
  let creatingThread = $state(false);

  /** Busy state for the shell: a send or a thread creation, whichever is live. */
  let isBusy = $derived(isSendingMessage || creatingThread);

  let shouldFocus = $derived(autoFocus && !isCoarsePointer && !isBusy && messagingState.previewImages.length === 0);

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
  /** The composer editor, so the Send button can submit through the exact
   *  same path as Enter (see `handleSendClick`). */
  let composer: ChatInputInstance | undefined = $state();

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
    // Directly enter threading mode: the plus-menu's "Create Thread" starts a
    // fresh thread with no pre-selected messages — not the multi-select flow
    // (message long-press / toolbar › Select). Zero selections creates the
    // thread empty.
    messagingState.startThreading();
    actionMenuOpen = false;
  }

  function handleForwardSelection() {
    if (messagingState.current.kind !== "selecting") return;
    onForwardSelection?.(messagingState.current.selectedMessages);
  }

  function handleMoveSelection() {
    if (messagingState.current.kind !== "selecting") return;
    onMoveSelection?.(messagingState.current.selectedMessages);
  }

  function handleDeleteSelection() {
    if (messagingState.current.kind !== "selecting") return;
    onDeleteSelection?.(messagingState.current.selectedMessages);
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

  /**
   * Send button. Delegates to the composer's `submit()` rather than calling
   * `handleSend` directly: `submit()` is the Enter-key path, which flushes a
   * trailing autolinked URL and serializes the editor's *current* document.
   * Calling `handleSend()` bare passes no blocks, which silently downgraded
   * the message to the legacy markdown body.
   */
  async function handleSendClick() {
    await composer?.submit();
  }

  async function handleSend(content = "", _mentions: string[] = [], submittedBlocks: Block[] = []) {
    const state = messagingState.current;
    if (state.kind === "threading" || state.kind === "selecting") return;
    if (!("input" in state)) return;
    // Presence check only (the editor's text is still mirrored into
    // `messagingState.input`); the body itself is always the blocks.
    if (!content && state.files.length === 0) return;

    isSendingMessage = true;

    const filesToUpload = [...state.files];

    /**
     * Hand the composer back to the user the moment the message is queued.
     *
     * A send is optimistic (see `pending-sends.svelte.ts`): the message is in
     * the room's timeline before the request goes out. From that point the
     * composer holds nothing the user still needs — the message is the room's
     * to deliver, and a failure leaves it marked "Not sent" with its own
     * Retry. Clearing here rather than after the round-trip is what lets the
     * user start composing the next message immediately.
     */
    let queued = false;
    function releaseComposer() {
      queued = true;
      messagingState.set({ kind: "normal", input: "", files: [], blocks: [], previewImages: [] });
      clearInput();
      isSendingMessage = false;
      setInputFocus();
    }

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

      await sendMessageMutation(spaceId, roomId, {
        blocks: submittedBlocks,
        ...(attachments.length > 0 ? { attachments } : {}),
        replyTo: state.kind === "replying" ? state.replyTo.id : undefined,
        onQueued: releaseComposer,
      });
    } catch (e: unknown) {
      console.error("Failed to send message:", e);
      // Route through the shared recovery: a dead ATProto session (e.g. the
      // OAuth client's `TokenRefreshError`) is exactly the class of failure
      // this reloads for, and sends are not Tanstack mutations, so the
      // QueryClient's onError hook never sees them. Without this the composer
      // silently swallowed the error and the user was left "unable to send
      // messages" with no recovery and no explanation.
      scheduleAutoReload(e);
      toast.error(
        e instanceof Error
          ? `Message not sent: ${e.message}`
          : "Message not sent. Check your connection and try again.",
      );
    } finally {
      // A message that never reached the queue (an upload failed) leaves the
      // draft intact so the user can retry without rewriting it. Once queued,
      // the composer is already cleared and the row carries the retry.
      if (!queued) {
        isSendingMessage = false;
        setInputFocus();
      }
    }
  }

  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // Thread creation
  async function handleCreateThread() {
    const state = messagingState.current;
    if (state.kind !== "threading") return;
    // In-flight guard: the submit button is disabled while this is set, but a
    // form submit can also arrive from the Enter key in the thread-name input,
    // which the disabled attribute does not cover.
    if (creatingThread) return;

    const name = state.name;
    const selectedIds = state.selectedMessages.map((m) => m.id);

    creatingThread = true;
    try {
      const threadId = await createThread({
        spaceId,
        parentRoomId: roomId,
        threadName: name,
        messageIds: selectedIds,
      });

      messagingState.set({ kind: "normal", input: "", files: [], blocks: [], previewImages: [] });
      clearInput();

      goto(`/${page.params.space}/${threadId}?parent=${roomId}`);
    } catch (e: unknown) {
      console.error("Failed to create thread:", e);
    } finally {
      // Cleared unconditionally: a failed create must not strand the button
      // disabled (the user needs to be able to retry).
      creatingThread = false;
    }
  }
</script>

<ChatInputShell
  {canWrite}
  isSendingMessage={isBusy}
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
  onSend={handleSendClick}
  onUploadMedia={handleUploadMedia}
  onCreateThreadFromMenu={handleCreateThreadFromMenu}
  onCreateThread={handleCreateThread}
  onForwardSelection={handleForwardSelection}
  onMoveSelection={onMoveSelection ? handleMoveSelection : undefined}
  onDeleteSelection={onDeleteSelection ? handleDeleteSelection : undefined}
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
        bind:this={composer}
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
