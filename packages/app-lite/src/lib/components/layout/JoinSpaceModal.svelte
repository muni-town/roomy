<script lang="ts">
  import { page } from "$app/state";
  import JoinDialog from "@roomy/design/components/modals/JoinDialog.svelte";
  import type {
    JoinResolveState,
    JoinState,
  } from "@roomy/design/components/modals/JoinDialog.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { joinSpace } from "$lib/mutations/space";
  import { queryClient } from "$lib/client";

  let { spaceId }: { spaceId: string } = $props();

  const inviteToken = $derived(
    page.url.searchParams.get("invite") ?? undefined,
  );
  const urlError = $derived(
    page.url.searchParams.get("joinError") ?? undefined,
  );

  let joinState = $state<JoinState>({ status: "idle" });

  const metaQuery = createSpaceMetadataQuery(() => spaceId);

  // Derive resolveState from the metadata query
  let resolveState = $derived.by<JoinResolveState>(() => {
    if (metaQuery.isPending) return { status: "loading" };
    if (metaQuery.isError) {
      const message =
        metaQuery.error instanceof Error
          ? metaQuery.error.message
          : String(metaQuery.error);
      return { status: "error", message };
    }
    if (metaQuery.data) {
      return {
        status: "success",
        data: {
          name: metaQuery.data.name ?? spaceId,
          allowPublicJoin: metaQuery.data.joinPolicy?.allowPublicJoin ?? false,
        },
      };
    }
    return { status: "loading" };
  });

  async function onJoin() {
    joinState = { status: "loading" };
    try {
      await joinSpace(spaceId, inviteToken);
      // Invalidate ALL cached queries for this space so stale error
      // responses (e.g. getThreads "you need to be a member", room
      // metadata canWrite=false) are cleared after joining.
      // Uses a predicate because room-scoped queries key on roomId
      // (not spaceId) — we match them by NSID prefix instead.
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const nsid = query.queryKey[0];
          if (typeof nsid !== "string") return false;

          // Match space-scoped queries by their spaceId param.
          const params = query.queryKey[1];
          if (
            params != null &&
            typeof params === "object" &&
            !Array.isArray(params) &&
            (params as Record<string, unknown>).spaceId === spaceId
          ) {
            return true;
          }

          // Also invalidate room-scoped queries so stale canWrite=false
          // and "no read access" errors are cleared after joining.
          if (nsid.startsWith("space.roomy.room.")) return true;

          return false;
        },
      });
      joinState = { status: "success" };
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message.includes("this space requires an invite to join")
            ? "Invalid invite link"
            : e.message
          : "Failed to join space";
      joinState = { status: "error", message };
    }
  }
</script>

<div class="fixed inset-0 z-40 flex items-center justify-center bg-base-50/95 dark:bg-base-950/95 backdrop-blur-sm">
  <JoinDialog {resolveState} {joinState} {inviteToken} {urlError} {onJoin}>
    {#snippet avatar()}
      <SpaceAvatar
        src={metaQuery.data?.avatar ?? undefined}
        id={spaceId}
        name={metaQuery.data?.name ?? ""}
        size={50}
      />
    {/snippet}
  </JoinDialog>
</div>
