<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import UserProfile from "./UserProfile.svelte";
  import { Virtualizer } from "virtua/svelte";
  import { setContext, onMount, onDestroy } from "svelte";
  import {
    Announcement,
    Message,
    type EntityIdStr,
    type Timeline,
  } from "@roomy-chat/sdk";
  import { derivePromise } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { globalState } from "$lib/global.svelte";
  
  // State for user profile dialog
  let showUserProfile = $state(false);
  let currentProfile = $state(null);
  
  // Handle profile click events
  function handleProfileClick(event) {
    currentProfile = event.detail;
    showUserProfile = true;
  }
  
  // Set up event listener for profile clicks
  onMount(() => {
    document.addEventListener('showUserProfile', handleProfileClick);
    return () => {
      document.removeEventListener('showUserProfile', handleProfileClick);
    };
  });
  
  // Close profile dialog
  function closeProfile() {
    showUserProfile = false;
    currentProfile = null;
  }

  let {
    timeline,
    virtualizer = $bindable(),
  }: {
    timeline: Timeline;
    virtualizer?: Virtualizer<string>;
  } = $props();

  let viewport: HTMLDivElement = $state(null!);
  let messagesLoaded = $state(false);

  setContext("scrollToMessage", (id: EntityIdStr) => {
    const idx = timeline.timeline.ids().indexOf(id);
    if (idx !== -1 && virtualizer) virtualizer.scrollToIndex(idx);
  });

  const messages = derivePromise([], async () => {
    const items = await timeline.timeline.items();
    messagesLoaded = true;
    return items
      .map((x) => x.tryCast(Message) || x.tryCast(Announcement))
      .filter((x) => !!x);
  });

  $effect(() => {
    page.route; // Scroll-to-end when route changes
    messages.value; // Scroll to end when message list changes.

    if (!viewport || !virtualizer) return;

    virtualizer.scrollToIndex(messages.value.length - 1, { align: "end" });
  });

  function shouldMergeWithPrevious(
    message: Message | Announcement,
    previousMessage?: Message | Announcement,
  ): boolean {
    const areMessages =
      previousMessage instanceof Message &&
      message instanceof Message &&
      !previousMessage.softDeleted;
    const authorsAreSame =
      areMessages &&
      message.authors((x) => x.get(0)) ==
        previousMessage.authors((x) => x.get(0));
    const messagesWithin5Minutes =
      (message.createdDate?.getTime() || 0) -
        (previousMessage?.createdDate?.getTime() || 0) <
      60 * 1000 * 5;
    const areAnnouncements =
      previousMessage instanceof Announcement &&
      message instanceof Announcement;
    const isSequentialMovedAnnouncement =
      areAnnouncements &&
      previousMessage.kind == "messageMoved" &&
      message.kind == "messageMoved" &&
      previousMessage.relatedThreads.ids()[0] ==
        message.relatedThreads.ids()[0];
    const mergeWithPrevious =
      (authorsAreSame && messagesWithin5Minutes) ||
      isSequentialMovedAnnouncement;
    return mergeWithPrevious;
  }
</script>

<div class="relative h-full">
  <!-- User Profile Dialog -->
  {#if showUserProfile && currentProfile}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div 
        class="absolute inset-0 bg-black/50"
        on:click={closeProfile}
      ></div>
      <div 
        class="relative bg-base-100 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden z-10"
        on:click|stopPropagation
      >
        <UserProfile 
          show={showUserProfile} 
          onClose={closeProfile}
          profileData={currentProfile}
        />
      </div>
    </div>
  {/if}
  
  <ScrollArea.Root type="scroll" class="h-full overflow-hidden">
    {#if !messagesLoaded}
    <!-- Important: This area takes the place of the chat which pushes chat offscreen
       which allows it to load then pop into place once the spinner is gone. -->
    <div class="grid items-center justify-center h-full w-full bg-transparent">
      <span class="dz-loading dz-loading-spinner"></span>
    </div>
  {/if}

  <ScrollArea.Viewport
    bind:ref={viewport}
    class="relative max-w-full w-full h-full"
  >
    <div class="flex flex-col-reverse w-full h-full">
      <ol class="flex flex-col gap-2 max-w-ful">
        <!--
        This use of `key` needs explaining. `key` causes the components below
        it to be deleted and re-created when the expression passed to it is changed.
        This means that every time the `viewport` binding si updated, the virtualizer
        will be re-created. This is important because the virtualizer only actually sets
        up the scrollRef when is mounted. And `viewport` is technically only assigned after
        _this_ parent component is mounted. Leading to a chicken-egg problem.

        Once the `viewport` is assigned, the virtualizer has already been mounted with scrollRef
        set to `undefined`, and it won't be re-calculated.

        By using `key` we make sure that the virtualizer is re-mounted after the `viewport` is
        assigned, so that it's scroll integration works properly.
      -->

        {#key viewport}
          <Virtualizer
            bind:this={virtualizer}
            data={messages.value}
            getKey={(message) => message.id}
            scrollRef={viewport}
          >
            {#snippet children(message: Message | Announcement, index: number)}
              {@const previousMessage =
                index > 0 ? messages.value[index - 1] : undefined}
              {#if !message.softDeleted}
                {@const isLinkThread = globalState.channel?.name === "@links"}
                <ChatMessage
                  {message}
                  mergeWithPrevious={!isLinkThread &&
                    shouldMergeWithPrevious(message, previousMessage)}
                  type={isLinkThread ? "link" : "message"}
                />
              {:else}
                <p class="italic text-error text-sm">
                  This message has been deleted
                </p>
              {/if}
            {/snippet}
          </Virtualizer>
        {/key}
      </ol>
    </div>
  </ScrollArea.Viewport>
  <ScrollArea.Scrollbar
    orientation="vertical"
    class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10 mr-1"
  >
    <ScrollArea.Thumb
      class="relative flex-1 rounded-full bg-base-300 transition-opacity"
    />
  </ScrollArea.Scrollbar>
  <ScrollArea.Corner />
</ScrollArea.Root>
</div>
