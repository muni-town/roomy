<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import type { Block } from "@roomy-space/sdk";
  import ForwardMessageModal, {
    type ForwardFetchState,
    type ForwardTarget,
  } from "@roomy/design/components/modals/ForwardMessageModal.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createSearchRoomsQuery } from "$lib/queries/search-rooms";
  import { forwardMessage } from "$lib/mutations/message";
  import ChatInput from "./ChatInput.svelte";
  import { createMentionSearch } from "$lib/tiptap/mentions";
  import { toast } from "@foxui/core";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let {
    open = $bindable(false),
    spaceId,
    fromRoomId,
    messageId,
  }: {
    open: boolean;
    spaceId: string;
    /** The room the forwarded message currently lives in. */
    fromRoomId: string;
    messageId: string;
  } = $props();

  // WYSIWYG composer body (markdown + blocks), bound from ChatInput.
  let body = $state("");
  let bodyBlocks: Block[] | undefined = $state();
  // DIDs mentioned in the commentary, kept in sync by ChatInput. Used for
  // the legacy markdown body path — rich-text bodies carry mentions in
  // their blocks' `#didMention` facets.
  let bodyMentions: string[] = $state([]);

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
      bodyMentions = [];
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
  const sidebarTargets = $derived.by<ForwardTarget[]>(() => {
    const meta = metaQuery.data;
    if (!meta) return [];

    const out: ForwardTarget[] = [];
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
  const searchTargets = $derived.by<ForwardTarget[]>(() => {
    const rooms = roomsSearchQuery.data?.rooms ?? [];
    const out: ForwardTarget[] = [];
    const seen = new Set<string>();
    for (const r of rooms) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, name: r.name });
    }
    return out;
  });

  const searching = $derived(searchQuery.trim().length > 0);

  const fetchState = $derived.by((): ForwardFetchState => {
    if (!open) return { status: "idle" };

    // Server search in flight: show the loading state for the first term
    // only, so the initial open (no query) renders instantly from cache.
    if (searching) {
      if (roomsSearchQuery.isPending && !roomsSearchQuery.data) {
        return { status: "loading" };
      }
      if (roomsSearchQuery.isError) {
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
    if (metaQuery.isError)
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

  async function handleForward(roomIds: string[]) {
    const hasBlocks = !!bodyBlocks && bodyBlocks.length > 0;
    await Promise.all(
      roomIds.map((roomId) =>
        forwardMessage(spaceId, fromRoomId, messageId, roomId, body, {
          ...(hasBlocks ? { blocks: bodyBlocks } : {}),
          ...(!hasBlocks && bodyMentions.length > 0 ? { mentions: bodyMentions } : {}),
        }),
      ),
    );
    toast.success(
      `Message forwarded to ${roomIds.length} room${roomIds.length > 1 ? "s" : ""}`,
    );
  }
</script>

<ForwardMessageModal
  bind:open
  bind:query={searchQuery}
  {fetchState}
  onForward={handleForward}
>
  {#snippet composer()}
    <ChatInput
      bind:content={body}
      bind:blocks={bodyBlocks}
      bind:mentions={bodyMentions}
      placeholder="Say something with the forwarded message…"
      onEnter={() => Promise.resolve()}
      sendOnEnter={false}
      setFocus={true}
      mentionSearch={createMentionSearch(spaceId, fromRoomId)}
    />
  {/snippet}
</ForwardMessageModal>
