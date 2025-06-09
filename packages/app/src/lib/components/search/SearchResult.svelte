<script lang="ts">
  import { Message, RoomyProfile } from "$lib/jazz/schema";
  import { CoState } from "jazz-svelte";
  import AvatarImage from "../AvatarImage.svelte";
  import { co } from "jazz-tools";

  let {
    messageId,
    onMessageClick,
    formatMessagePreview,
  }: {
    messageId: string;
    onMessageClick: (messageId: string) => void;
    formatMessagePreview: (message: co.loaded<typeof Message>) => string;
  } = $props();

  const message = $derived(new CoState(Message, messageId));

  let profile = $derived(
    new CoState(RoomyProfile, message.current?._edits.content?.by?.profile?.id),
  );

  const authorData = $derived.by(() => {
    // if the message has an author in the format of discord:username:avatarUrl,
    // and the message is made by the admin, return the profile data otherwise return profile data
    if (message.current?.author?.includes("discord:")) {
      return {
        name: message.current?.author?.split(":")[1],
        imageUrl: decodeURIComponent(
          message.current?.author?.split(":")[2] ?? "",
        ),
        id: undefined,
      };
    }
    return profile.current;
  });
</script>

{#if message.current && authorData}
  <li class="hover:bg-base-200 transition-colors relative isolate">
    <div class="p-3 flex items-start gap-2">
      <AvatarImage
        handle={authorData.name || ""}
        avatarUrl={authorData.imageUrl}
        className="w-8 h-8"
      />
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-center mb-1">
          <span class="font-medium text-base-content"
            >{authorData.name || "Unknown"}</span
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
          <button
            onclick={() => {
              onMessageClick(message.current!.id);
            }}
          >
            {@html formatMessagePreview(message.current)}
            <span class="absolute inset-0"></span>
          </button>
        </div>
      </div>
    </div>
  </li>
{/if}
