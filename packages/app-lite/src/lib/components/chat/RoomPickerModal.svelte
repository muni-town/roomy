<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import type { Block } from "@roomy-space/sdk";
  import RoomPickerModal, {
    type RoomPickerFetchState,
    type RoomPickerTarget,
    type RoomPickerMode,
  } from "@roomy/design/components/modals/RoomPickerModal.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createSearchRoomsQuery } from "$lib/queries/search-rooms";
  import { forwardMessages, moveMessages } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";
  import ChatInput from "./ChatInput.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { createMentionSearch } from "$lib/tiptap/mentions";
  import { toast } from "@foxui/core";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let {
    open = $bindable(false),
    mode = "forward",
    spaceId,
    fromRoomId,
    messages,
  }: {
    open: boolean;
    /** `forward` cross-posts as new forward messages (with commentary);
     *  `move` relocates the originals. */
    mode?: RoomPickerMode;
    spaceId: string;
    /** The room the forwarded/moved messages currently live in. */
    fromRoomId: string;
    /** The messages to forward or move. Kept in full (not just their ids):
     *  forwarding has to order them by the source room's timeline key, which
     *  is the `sort_idx` the server returned with each message. */
    messages: Message[];
  } = $props();

  // Composer body, bound from ChatInput. `body`/`bodyBlocks` mirror the
  // editor for the modal's own reactivity; the sent body is read from the
  // editor via `composerRef.getBlocks()` at forward time.
  let body = $state("");
  let bodyBlocks: Block[] | undefined = $state();
  /** The forward commentary editor. (`composer` is taken by the design
   *  modal's snippet prop below, so this ref is named for what it holds.
   *  Only mounted in forward mode.) */
  let composerRef: { getBlocks: () => Block[] } | undefined = $state();

  // Room-name search term typed into the modal's input. The design modal
  // owns the input (bind:query); when non-empty we search the server for
  // every matching channel/thread in the space instead of relying on the
  // cached activeThreads list (which is capped at 8 and only includes
  // recently-active threads).
  let searchQuery = $state("");

  // Reset the composer each time the modal opens.
  $effect(() => {
    if (open) {
      body = "";
      bodyBlocks = undefined;
    }
  });

  const metaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: open,
  });

  const roomsSearchQuery = createSearchRoomsQuery(
    () => spaceId,
    () => searchQuery,
  );

  // Candidate targets from the cached sidebar: channels the user can write
  // to (with their recently active threads), plus writable active threads
  // of unreadable channels. Readable channels' threads render under the
  // channel as "suggested".
  const sidebarTargets = $derived.by<RoomPickerTarget[]>(() => {
    const meta = metaQuery.data;
    if (!meta) return [];

    const out: RoomPickerTarget[] = [];
    const seen = new Set<string>();
    const push = (id: string, name?: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, name });
    };

    const pushChannel = (ch: SidebarChannel) => {
      if (ch.canWrite) push(ch.id, ch.name);
      for (const t of ch.activeThreads ?? []) {
        if (t.canWrite) push(t.id, t.name);
      }
    };

    for (const cat of meta.sidebar.categories) {
      for (const ch of cat.channels) {
        if (ch.canRead) {
          pushChannel(ch);
        } else {
          for (const t of ch.activeThreads ?? []) {
            if (t.canWrite) push(t.id, t.name);
          }
        }
      }
    }
    for (const ch of meta.sidebar.orphans) {
      if (ch.canRead) {
        pushChannel(ch);
      } else {
        for (const t of ch.activeThreads ?? []) {
          if (t.canWrite) push(t.id, t.name);
        }
      }
    }
    return out;
  });

  // Searching: the server is authoritative. Search results already carry
  // read-access filtering + names; dedupe channels and threads by id.
  const searchTargets = $derived.by<RoomPickerTarget[]>(() => {
    const rooms = roomsSearchQuery.data?.rooms ?? [];
    const out: RoomPickerTarget[] = [];
    const seen = new Set<string>();
    for (const r of rooms) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, name: r.name });
    }
    return out;
  });

  const searching = $derived(searchQuery.trim().length > 0);

  const fetchState = $derived.by((): RoomPickerFetchState => {
    if (!open) return { status: "idle" };

    // Server search in flight: show the loading state for the first term
    // only, so the initial open (no query) renders instantly from cache.
    if (searching) {
      if (roomsSearchQuery.isPending && !roomsSearchQuery.data) {
        return { status: "loading" };
      }
      if (roomsSearchQuery.isLoadingError) {
        return {
          status: "error",
          message:
            roomsSearchQuery.error instanceof Error
              ? roomsSearchQuery.error.message
              : "Failed to search rooms",
        };
      }
      const data = searchTargets.filter((t) => t.id !== fromRoomId);
      return { status: "success", data };
    }

    if (metaQuery.isPending) return { status: "loading" };
    if (metaQuery.isLoadingError)
      return {
        status: "error",
        message:
          metaQuery.error instanceof Error
            ? metaQuery.error.message
            : "Failed to load rooms",
      };
    const data = sidebarTargets.filter((t) => t.id !== fromRoomId);
    return { status: "success", data };
  });

  /** Leave select mode after an action consumes the selection
   *  (Signal/WhatsApp pattern). Harmless for the single-message toolbar path
   *  — state is already normal, and `setNormal` preserves the draft. */
  function consumeSelection() {
    if (messagingState.current.kind === "selecting") {
      messagingState.setNormal();
    }
  }

  async function handleForward(roomIds: string[]) {
    // Read the commentary from the editor rather than the `blocks` binding:
    // that binding stays undefined until the modal's editor is edited, so an
    // empty (or only-pasted) commentary would otherwise take the legacy
    // markdown branch.
    const blocks = composerRef?.getBlocks() ?? bodyBlocks ?? [];
    // One destination room, one ordered batch. Sending the destinations in
    // parallel is fine — they are independent rooms — but the messages within
    // a room must stay in source-timeline order, which `forwardMessages`
    // enforces (it sorts the targets and stamps increasing canonical times).
    await Promise.all(
      roomIds.map((roomId) =>
        forwardMessages(spaceId, fromRoomId, roomId, messages, { blocks }),
      ),
    );
    toast.success(
      `Forwarded ${messages.length} message${messages.length > 1 ? "s" : ""} to ${roomIds.length} room${roomIds.length > 1 ? "s" : ""}`,
    );
    consumeSelection();
  }

  async function handleMove(roomIds: string[]) {
    const toRoomId = roomIds[0];
    if (!toRoomId) return;
    await moveMessages(
      spaceId,
      fromRoomId,
      messages.map((m) => m.id),
      toRoomId,
    );
    toast.success(
      `Moved ${messages.length} message${messages.length > 1 ? "s" : ""}`,
    );
    consumeSelection();
  }
</script>

<RoomPickerModal
  bind:open
  {mode}
  bind:query={searchQuery}
  {fetchState}
  onSelect={mode === "move" ? handleMove : handleForward}
>
  {#snippet composer()}
    <ChatInput
      bind:this={composerRef}
      bind:content={body}
      bind:blocks={bodyBlocks}
      placeholder="Say something with the forwarded message…"
      onEnter={() => Promise.resolve()}
      sendOnEnter={false}
      setFocus={true}
      mentionSearch={createMentionSearch(spaceId, fromRoomId)}
    />
  {/snippet}
</RoomPickerModal>
