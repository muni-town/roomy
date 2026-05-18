<script lang="ts">
  import { page } from "$app/state";
  import BoardViewItemShell from "@roomy/design/components/content/thread/boardView/BoardViewItem.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import type { Ulid } from "@roomy-space/sdk";

  let {
    thread,
    parent,
  }: { thread: ThreadInfo; activityCountMax?: number; parent?: Ulid } =
    $props();

  const href = $derived(
    `/${page.params.space}/${thread.id}${parent ? "?parent=" + parent : thread.canonicalParent ? "?parent=" + thread.canonicalParent : ""}`,
  );
</script>

<BoardViewItemShell {thread} {href} />
