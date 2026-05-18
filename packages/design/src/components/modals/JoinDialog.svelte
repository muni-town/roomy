<script lang="ts" module>
  export type JoinResolveState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "success";
        data: { name: string; allowPublicJoin: boolean };
      };

  export type JoinState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "success"; data?: unknown }
    | { status: "error"; message: string };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { Box } from "@foxui/core";
  import Button from "../ui/button/Button.svelte";
  import ErrorModal from "./Error.svelte";

  let {
    resolveState,
    joinState,
    inviteToken,
    urlError,
    avatar,
    onJoin,
  }: {
    resolveState: JoinResolveState;
    joinState: JoinState;
    /** When set, the space is being joined via invite link. */
    inviteToken?: string;
    /** Error message from a prior join attempt persisted across remounts. */
    urlError?: string;
    /** Avatar rendered by caller (e.g. SpaceAvatar wrapper). */
    avatar: Snippet;
    onJoin: () => void;
  } = $props();
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
          {@render avatar()}

          <h1 class="font-bold text-xl">{resolveState.data.name}</h1>
        </div>
        {#if canJoin}
          <Button size="lg" asyncState={joinState} onclick={onJoin}>
            {inviteToken ? "Accept Invite" : "Join Space"}
          </Button>
          {#if joinState.status === "error"}
            <p class="text-sm text-center text-red-600 dark:text-red-400 mt-2">
              {joinState.message}
            </p>
          {:else if urlError}
            <p class="text-sm text-center text-red-600 dark:text-red-400 mt-2">
              {urlError}
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
