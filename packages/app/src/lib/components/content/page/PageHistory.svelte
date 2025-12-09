<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import { Button, ScrollArea } from "@fuxui/base";
  import { decodeTime } from "ulidx";
  import {
    patchApply,
    patchFromText,
    diff,
    diffPrettyHtml,
    type Diff,
  } from "diff-match-patch-es";
  import { formatDistanceToNow } from "date-fns";

  let historyQuery = new LiveQuery<{
    content: string;
    edit_id: string;
    mime_type: string;
    authorName: string;
    authorAvatar: string;
  }>(
    () => sql`
    select
      cast(data as text) as content,
      id(edit_id) as edit_id,
      mime_type,
      user_info.name as authorName,
      user_info.avatar as authorAvatar
    from comp_page_edits
    join comp_info user_info on user_info.entity = user_id
    where
      comp_page_edits.entity = ${page.params.object && id(page.params.object)}
  `,
  );

  type PointInTime = {
    date: Date;
    diffs: Diff[];
    authorName?: string;
    authorAvatar?: string;
  };

  let pointsInTime: PointInTime[] = $derived.by(() => {
    const pointsInTime: PointInTime[] = [];

    let previousContent = "";

    if (historyQuery.current.status !== "success") {
      return pointsInTime;
    }

    for (const edit of historyQuery.current.data || []) {
      const date = new Date(decodeTime(edit.edit_id));

      if (edit.mime_type == "text/x-dmp-patch") {
        const patch = patchFromText(edit.content);
        const [contentAtPointMd] = patchApply(patch, previousContent) as [
          string,
          boolean[],
        ];
        const contentAtPoint = contentAtPointMd;
        const diffs = diff(previousContent, contentAtPoint, {
          patchMargin: 40,
        });

        pointsInTime.push({
          date,
          diffs,
          authorName: edit.authorName,
          authorAvatar: edit.authorAvatar,
        });
        previousContent = contentAtPoint;
      } else {
        pointsInTime.push({
          date,
          diffs: diff(previousContent, edit.content),
          authorName: edit.authorName,
          authorAvatar: edit.authorAvatar,
        });
        previousContent = edit.content;
      }
    }

    return pointsInTime.reverse();
  });

  let currentPointIdx = $state(0);
  let currentPoint = $derived(pointsInTime[currentPointIdx]);
</script>

<div class="p-3 flex flex-col grow max-h-full">
  <h2 class="text-lg font-bold px-4 py-2 mt-4">Edit History</h2>

  <ScrollArea orientation="horizontal" class="shrink-0">
    <div class="flex gap-3 my-3 px-4">
      {#each pointsInTime as point, i}
        <Button class="shrink-0" onclick={() => (currentPointIdx = i)}>
          <img
            src={point.authorAvatar}
            class="size-5 rounded-full"
            alt="Author avatar"
          />
          Version {pointsInTime.length - i} by {point.authorName} - {formatDistanceToNow(
            point.date,
          )} ago
        </Button>
      {/each}
    </div>
  </ScrollArea>

  {#if currentPoint}
    <ScrollArea orientation="vertical" class="grow max-h-full mt-2 py-8 px-4">
      <div class="diff">
        {@html diffPrettyHtml(currentPoint.diffs)}
      </div>
    </ScrollArea>
  {/if}
</div>

<style>
  :global(.dark .diff del) {
    background-color: hsla(0, 70%, 30%) !important;
  }
  :global(.dark .diff ins) {
    background-color: hsla(134, 70%, 15%) !important;
  }
</style>
