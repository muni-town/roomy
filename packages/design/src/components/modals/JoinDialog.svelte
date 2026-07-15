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
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import ErrorModal from "./Error.svelte";
  import UpdateRhythmChooser, {
    type RhythmLevel,
    DEFAULT_RHYTHM,
  } from "../user/UpdateRhythmChooser.svelte";

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
    /**
     * Called with the chosen notification rhythm when the user clicks Join.
     * The caller is responsible for `joinSpace` + persisting the level via
     * `setPreferences({ spaceId, level })`.
     */
    onJoin: (level: RhythmLevel) => void;
  } = $props();

  // The chosen notification rhythm, defaulted to the appserver's default
  // ("engaged"). Lives in the dialog so the chooser stays controlled here.
  let rhythm = $state<RhythmLevel>(DEFAULT_RHYTHM);
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

          <h1 class="font-bold text-xl min-w-0 truncate" title={resolveState.data.name}>{resolveState.data.name}</h1>
        </div>
        {#if canJoin}
          <div class="mb-5">
            <p class="text-xs font-semibold uppercase tracking-wider text-base-400 dark:text-base-500 mb-2 px-1">
              Choose your update rhythm
            </p>
            <UpdateRhythmChooser bind:value={rhythm} />
          </div>

          <Button size="lg" asyncState={joinState} onclick={() => onJoin(rhythm)}>
            {inviteToken ? "Accept Invite" : "Join Space"}
          </Button>
          {#if joinState.status === "error"}
            <ErrorMessage message={joinState.message} class="mt-2 justify-center" iconSize="size-4" />
          {:else if urlError}
            <ErrorMessage message={urlError} class="mt-2 justify-center" iconSize="size-4" />
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
