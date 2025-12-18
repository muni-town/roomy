<script lang="ts">
  import { page } from "$app/state";
  import { Box, Button } from "@fuxui/base";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { joinSpace } from "$lib/mutations/space";
  import { type SpaceIdOrHandle, type DidStream } from "$lib/workers/types";
  import { backend } from "$lib/workers";

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  type JoinStatus =
    | { status: "loading" }
    | { status: "ready"; spaceId: DidStream }
    | { status: "joining" }
    | { status: "success" }
    | {
        status: "error";
        message: string;
      };
  let joinStatus: JoinStatus = $state({ status: "loading" });

  function error(message: string) {
    console.error(message);
    joinStatus = { status: "error", message };
  }

  $effect(() => {
    (async () => {
      if (!page.params.space) {
        error("No space ID or handle provided");
        return;
      }
      const resolvedSpace = await backend.resolveSpaceId(
        page.params.space as SpaceIdOrHandle,
      );
      if (resolvedSpace) {
        joinStatus = { status: "ready", spaceId: resolvedSpace.spaceId };
      } else {
        error("This space doesn't exist or has been deleted...");
      }
    })();
  });
</script>

<div class="flex items-center justify-center h-full">
  <Box class="w-[20em] flex flex-col">
    {#if joinStatus.status === "loading"}
      <p class="text-sm text-center">Loading space...</p>
    {/if}
    {#if joinStatus.status === "error"}<p
        class="text-sm text-red-700 dark:text-red-400 text-center"
      >
        {joinStatus.message}
      </p>{/if}
    {#if joinStatus.status === "ready" || joinStatus.status === "joining"}
      <div class="mb-5 flex justify-center items-center gap-3">
        <SpaceAvatar
          imageUrl={inviteSpaceAvatar ?? ""}
          id={page.params.space}
          name={inviteSpaceName ?? ""}
          size={50}
        />
        {#if inviteSpaceName}
          <h1 class="font-bold text-xl">{inviteSpaceName}</h1>
        {/if}
      </div>
      <Button
        size="lg"
        disabled={joinStatus.status !== "ready"}
        onclick={() =>
          joinStatus.status === "ready"
            ? joinSpace(joinStatus.spaceId)
            : error("No space ID provided")}>Join Space</Button
      >
    {/if}
  </Box>
</div>
