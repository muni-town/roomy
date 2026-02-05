<script lang="ts">
  import { onMount } from "svelte";
  import {
    dmClient,
    type Conversation,
    type Participant,
  } from "$lib/dm.svelte";
  import { Avatar, Badge, cn } from "@fuxui/base";
  import { fade } from "svelte/transition";

  import { IconAlertCircle, IconMessageCircleOff } from "@roomy/design/icons";

  let {
    selectedConversationId,
  }: {
    selectedConversationId?: string | null;
  } = $props();

  let conversations: Conversation[] = $state([]);
  let isLoading = $state(true);
  let error: string | null = $state(null);

  // Load conversations when component mounts
  onMount(async () => {
    try {
      await dmClient.init();
      conversations = await dmClient.getConversations();
    } catch (err) {
      console.error("Failed to load conversations:", err);
      error = `Failed to load conversations: ${err instanceof Error ? err.message : err}`;

      conversations = [];
    } finally {
      isLoading = false;
    }
  });

  function getConversationNames(participants: Participant[]) {
    const myDid = dmClient.getCurrentUserDid();
    const participantsWithoutMe = participants.filter((p) => p.did !== myDid);

    const participantNames = participantsWithoutMe
      .slice(0, 2)
      .map((p) => p.displayName || p.handle);
    let names = participantNames.join(", ");

    if (participantsWithoutMe.length > 2) {
      names += ` + ${participantsWithoutMe.length - 2} more`;
    }

    if (participantsWithoutMe.length === 0) {
      return "You";
    }

    return names;
  }

  function getConversationAvatar(participants: Participant[]) {
    const myDid = dmClient.getCurrentUserDid();
    const participantsWithoutMe = participants.filter((p) => p.did !== myDid);
    return participantsWithoutMe[0]?.avatar;
  }
</script>

{#if isLoading}
  <div class="text-center py-4">
    <span class="loading loading-spinner loading-md text-primary"></span>
    <p class="mt-2 text-sm text-base-700 dark:text-base-300">
      Loading conversations...
    </p>
  </div>
{:else if error}
  <div class="alert alert-error m-4">
    <IconAlertCircle />
    <div>
      <div class="font-bold">Error</div>
      <div class="text-xs">{error}</div>
    </div>
    <button
      onclick={() => window.location.reload()}
      class="btn btn-sm btn-outline"
    >
      Try again
    </button>
  </div>
{:else if conversations.length === 0}
  <div class="text-center py-8">
    <IconMessageCircleOff
      class="h-8 w-8 mx-auto text-base-content/40 mb-2"
    />
    <p class="text-base-content/60">No conversations yet</p>
    <button
      onclick={() => {
        conversations = [
          {
            id: "test-1",
            participants: [
              {
                did: "test",
                handle: "test.bsky.social",
                displayName: "Test User",
              },
            ],
            lastMessage: {
              text: "Test message",
              sentAt: new Date().toISOString(),
            },
            unreadCount: 1,
          },
        ];
      }}
      class="btn btn-sm btn-primary mt-2"
    >
      Add Test Conversation
    </button>
  </div>
{:else}
  {#each conversations as conversation}
    {#key conversation}
      <a
        onclick={() => {
          conversation.unreadCount = 0;
        }}
        class={cn(
          "flex items-center gap-2 justify-between w-full px-3 py-1.5 text-left transition-colors relative border-0 bg-transparent rounded-xl",
          selectedConversationId === conversation.id
            ? "bg-accent-500/5 text-accent-600 dark:text-accent-400"
            : "hover:bg-base-200/50 dark:hover:bg-base-800/50 text-base-900 dark:text-base-100",
        )}
        href={`/messages/${conversation.id}`}
      >
        {#if selectedConversationId === conversation.id}
          <span
            transition:fade
            class="from-accent-500/0 via-accent-500/60 to-accent-500/0 dark:from-accent-400/0 dark:via-accent-400/60 dark:to-accent-400/0 absolute inset-y-1 right-0 w-px bg-gradient-to-b"
          ></span>
        {/if}
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium truncate w-full">
            <div class="flex items-center gap-2">
              <Avatar src={getConversationAvatar(conversation.participants)} />

              {getConversationNames(conversation.participants)}
            </div>
          </div>
          {#if conversation.lastMessage}
            <p
              class="text-sm truncate mt-1 w-full
                   {selectedConversationId === conversation.id
                ? 'text-primary/70'
                : 'text-base-content/60'}"
            >
              {conversation.lastMessage.text}
            </p>
          {/if}
        </div>
        {#if conversation.unreadCount > 0}
          <Badge>
            {conversation.unreadCount}
          </Badge>
        {/if}
      </a>
    {/key}
  {/each}
{/if}
