<script lang="ts">
  import { page } from "$app/state";
  import { AvatarGroup, Box } from "@fuxui/base";
  import { formatDistance } from "date-fns";
  import type { ThreadInfo } from "./types";

  let { thread }: { thread: ThreadInfo } = $props();

  // let threadComponent = $derived(
  //   new CoState(ThreadComponent, thread.components?.[ThreadComponent.id], {
  //     resolve: { timeline: true },
  //   }),
  // );

  // // Note: this is by far the preferred way to do this, but unfortunately the bridge makes
  // // everything authored by the same person and the timestamp is the time it was bridged,
  // // not the time it was posted.
  // //
  // // let authorIds = $derived(
  // //   Object.values(threadComponent.current?.timeline?.perAccount || {}).map(
  // //     (x) => x.by?.id as string,
  // //   ),
  // // );

  // let lastMessageTimestamp = $derived(
  //   Object.values(threadComponent.current?.timeline?.perSession || {})
  //     .map((x) => x.madeAt)
  //     .sort((a, b) => b.getTime() - a.getTime())[0],
  // );

  // let avatars = $state([]) as string[];
  // $effect(() => {
  //   // We just grab a handful of messages from the channel to get their authors for now.
  //   const messageIds = Object.values(
  //     threadComponent.current?.timeline.perAccount || {},
  //   )
  //     .map((x) => [...x.all].map((x) => x.value))
  //     .flat()
  //     .slice(-10, -1);
  //   untrack(async () => {
  //     avatars = [
  //       ...new Set(
  //         (
  //           await Promise.all(
  //             messageIds.map(async (messageId) => {
  //               const ent = await RoomyEntity.load(messageId);
  //               if (!ent) return;
  //               const customAuthor = await getComponent(ent, AuthorComponent);
  //               if (customAuthor) {
  //                 return customAuthor.imageUrl;
  //               }
  //             }),
  //           )
  //         ).filter((x) => !!x) as string[],
  //       ),
  //     ];
  //   });
  // });
</script>

<a href={`/${page.params.space}/${thread.id}`}>
  <Box class="flex items-center">
    {thread.name}
    <span class="flex-grow"></span>
    <span class="mr-8">
      <AvatarGroup
        users={thread.members.map((m) => ({
          src: m.avatar,
          fallback: "U",
          alt: "U",
        }))}
      />
    </span>
    <!-- {#if lastMessageTimestamp}
      {formatDistance(Date.now(), lastMessageTimestamp)}
    {/if} -->
  </Box>
</a>
