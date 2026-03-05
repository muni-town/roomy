<script lang="ts">
  import { page } from "$app/state";
  import { Box } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { joinSpace } from "$lib/mutations/space";
  import { type SpaceIdOrHandle } from "$lib/workers/types";
  import { peer } from "$lib/workers";
  import { StreamDid, type AsyncStateWithIdle } from "@roomy/sdk";
  import ErrorModal from "./Error.svelte";

  let spaceDid = $state<StreamDid>();

  let spaceName = $state() as string | undefined;
  let spaceAvatar = $state() as string | undefined;

  // State for resolving the space
  let resolveState: AsyncStateWithIdle<{
    spaceId: StreamDid;
    name: string;
    avatar?: string;
  }> = $state({
    status: "loading",
  });

  // State for joining the space
  let joinState: AsyncStateWithIdle<void> = $state({ status: "idle" });

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
      await joinSpace(resolveState.data.spaceId);
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
        <div class="mb-5 flex justify-center items-center gap-3">
          <SpaceAvatar
            imageUrl={spaceAvatar ?? ""}
            id={page.params.space}
            name={spaceName ?? ""}
            size={50}
          />

          <h1 class="font-bold text-xl">{spaceName}</h1>
        </div>
        <Button size="lg" asyncState={joinState} onclick={handleJoin}>
          Join Space
        </Button>
      {/if}
    </Box>
  {/if}
</div>
