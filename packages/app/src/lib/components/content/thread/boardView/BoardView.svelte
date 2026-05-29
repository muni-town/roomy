<script lang="ts">
  import { page } from "$app/state";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import type { Ulid } from "@roomy-space/sdk";

  const {
    threads,
    emptyMessage = "No items",
    parent,
  }: {
    threads: ThreadInfo[];
    emptyMessage?: string;
    parent?: Ulid;
  } = $props();

  function hrefFor(thread: ThreadInfo): string {
    const parentParam = parent
      ? "?parent=" + parent
      : thread.canonicalParent
        ? "?parent=" + thread.canonicalParent
        : "";
    return `/${page.params.space}/${thread.id}${parentParam}`;
  }
</script>

<BoardViewShell {threads} {emptyMessage} {hrefFor} />
