<script lang="ts">
  import { page } from "$app/state";
  import { Box } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { joinSpace } from "$lib/mutations/space";
  import { type SpaceIdOrHandle } from "$lib/workers/types";
  import { peer } from "$lib/workers";
  import { StreamDid, type AsyncStateWithIdle } from "@roomy-space/sdk";
  import ErrorModal from "./Error.svelte";

  let spaceDid = $state<StreamDid>();

  // State for resolving the space
  let resolveState: AsyncStateWithIdle<{
    spaceId: StreamDid;
    name: string;
    avatar?: string;
    allowPublicJoin: boolean;
  }> = $state({
    status: "loading",
  });

  // State for joining the space
  let joinState: AsyncStateWithIdle<void> = $state({ status: "idle" });

  // Invite token from URL query param (e.g. ?invite=abc-123)
  let inviteToken = $derived(page.url.searchParams.get("invite") ?? undefined);

  $effect(() => {
    (async () => {
      if (!page.params.space) {
        resolveState = {
          status: "error",
          message: "No space ID or handle provided",
        };
        return;
      }
      const resolvedSpace = await peer.resolveSpaceId(
        page.params.space as SpaceIdOrHandle,
      );
      if (resolvedSpace) {
        spaceDid = resolvedSpace.spaceId;
      } else {
        resolveState = {
          status: "error",
          message: "This space doesn't exist or has been deleted...",
        };
      }
    })();
  });

  $effect(() => {
    const spaceId = spaceDid;
    if (spaceId) {
      peer.getSpaceInfo(spaceId).then((info) => {
        if (info && info.name)
          resolveState = {
            status: "success",
            data: {
              spaceId,
              name: info.name,
              avatar: info?.avatar,
              allowPublicJoin: info.allowPublicJoin ?? true,
            },
          };
        else
          resolveState = {
            status: "error",
            message: "This space doesn't exist or has been deleted...",
          };
      });
    }
  });

  async function handleJoin() {
    if (resolveState.status !== "success") return;
    joinState = { status: "loading" };
    try {
      await joinSpace(resolveState.data.spaceId, inviteToken);
      joinState = { status: "success", data: undefined };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to join space";
      joinState = { status: "error", message };
    }
  }
</script>

<div class="flex items-center justify-center h-full">
  {#if resolveState.status === "error"}
    <ErrorModal message={resolveState.message} goHome />
  {:else}
    <Box class="w-[20em] flex flex-col">
      {#if resolveState.status === "loading"}
        <p class="text-sm text-center">Loading space...</p>
      {/if}

      {#if resolveState.status === "success"}
        {@const canJoin = resolveState.data.allowPublicJoin || !!inviteToken}
        <div class="mb-5 flex justify-center items-center gap-3">
          <SpaceAvatar
            imageUrl={resolveState.data.avatar ?? ""}
            id={page.params.space}
            name={resolveState.data.name ?? ""}
            size={50}
          />

          <h1 class="font-bold text-xl">{resolveState.data.name}</h1>
        </div>
        {#if canJoin}
          <Button size="lg" asyncState={joinState} onclick={handleJoin}>
            {inviteToken ? "Accept Invite" : "Join Space"}
          </Button>
          {#if joinState.status === "error"}
            <p class="text-sm text-center text-red-600 dark:text-red-400 mt-2">
              {joinState.message}
            </p>
          {/if}
        {:else}
          <p class="text-sm text-center text-base-500 dark:text-base-400">
            This space is invite-only. You need an invite link to join.
          </p>
        {/if}
      {/if}
    </Box>
  {/if}
</div>
