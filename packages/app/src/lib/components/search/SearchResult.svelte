<script lang="ts">
  import { Message, RoomyProfile } from "$lib/jazz/schema";
  import { CoState } from "jazz-svelte";
  import AvatarImage from "../AvatarImage.svelte";

  let {message, onMessageClick, formatMessagePreview}: {
    message: typeof Message;
    onMessageClick: (messageId: string) => void;
    formatMessagePreview: (message: typeof Message) => string;
  } = $props();
  let profile = $derived(
    new CoState(RoomyProfile, message.current?._edits.content?.by?.profile?.id),
  );
</script>

<li class="hover:bg-base-200 transition-colors">
  <button
    type="button"
    class="p-3 flex items-start gap-2"
    onclick={() => {
      // Just call onMessageClick and don't try to scroll directly from here
      // This will avoid the postMessage error
      onMessageClick(message.current?.id);
    }}
  >
    <AvatarImage
        handle={profile.current?.blueskyHandle || ""}
        avatarUrl={profile.current?.imageUrl}
        className="w-8 h-8"
      />
    <div class="flex-1 min-w-0">
      <div class="flex justify-between items-center mb-1">
        <span class="font-medium text-base-content"
          >{profile.current?.blueskyHandle || "Unknown"}</span
        >
        <span class="text-xs text-base-content/60">
          <!-- {message._edits?.createdDate
              ? formatDistanceToNow(message._edits.createdDate, {
                  addSuffix: true,
                })
              : ""} -->
        </span>
      </div>
      <div class="text-sm text-base-content/80 line-clamp-2 break-words">
        {@html formatMessagePreview(message.current)}
      </div>
    </div>
  </button>
</li>
