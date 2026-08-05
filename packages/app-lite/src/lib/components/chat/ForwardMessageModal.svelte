<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import ForwardMessageModal, {
    type ForwardFetchState,
    type ForwardTarget,
  } from "@roomy/design/components/modals/ForwardMessageModal.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { forwardMessage } from "$lib/mutations/message";
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

  const metaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: open,
  });

  const targets = $derived.by<ForwardTarget[]>(() => {
    const meta = metaQuery.data;
    if (!meta) return [];

    // Candidate targets: channels the user can write to (with their recently
    // active threads), plus writable active threads of unreadable channels.
    // Readable channels' threads render under the channel as "suggested".
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

  const fetchState = $derived.by((): ForwardFetchState => {
    if (!open) return { status: "idle" };
    if (metaQuery.isPending) return { status: "loading" };
    if (metaQuery.isError)
      return {
        status: "error",
        message:
          metaQuery.error instanceof Error
            ? metaQuery.error.message
            : "Failed to load rooms",
      };
    const data = targets.filter((t) => t.id !== fromRoomId);
    return { status: "success", data };
  });

  async function handleForward(roomId: string) {
    await forwardMessage(spaceId, fromRoomId, messageId, roomId);
    toast.success("Message forwarded");
  }
</script>
<ForwardMessageModal bind:open {fetchState} onForward={handleForward} />
