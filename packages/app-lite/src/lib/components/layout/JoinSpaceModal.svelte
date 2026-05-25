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
  import { cache } from "@roomy-space/sdk";

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
  let resolveState = $derived<JoinResolveState>(() => {
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
      // Invalidate metadata + spaces lists so membership state refreshes
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.space.getMetadata", {
          spaceId,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.space.getSpaces"),
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
