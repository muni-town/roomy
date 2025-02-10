<script lang="ts">
  import { Button } from "bits-ui";
  import { decodeTime } from "ulidx";
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { formatDistanceToNowStrict } from "date-fns";
  import type { Ulid, Thread } from "$lib/schemas/types";

  type Props = {
    id: Ulid;
    thread: Thread;
    onclick: () => void;
    onclickDelete: () => void;
  }

  let { id, thread, onclick, onclickDelete }: Props = $props();
  let latest = $derived.by(() => {
    let allTime: number[] = [];
    for (const id of thread.timeline) {
      allTime.push(decodeTime(id));
    }
    allTime.sort();
    return new Date(allTime[allTime.length-1]);
  });
</script>

<div {id} class="border border-white rounded text-white flex w-full justify-between p-4 hover:bg-white/5 transition-all duration-75">
  <Button.Root {onclick} class="flex flex-col gap-2 grow cursor-pointer">
    <h1 class="text-xl font-semibold">{thread.title}</h1>
    <time class="text-sm text-gray-300">Latest: {formatDistanceToNowStrict(latest)} ago</time>
  </Button.Root>
  <div class="flex gap-4 items-center">
    <p class="flex gap-2 items-center">
      {thread.timeline.length}
      <Icon icon="tabler:message" class="text-2xl" />
    </p>
    <Dialog title="Delete Thread" description="The thread will be unrecoverable once deleted">
      {#snippet dialogTrigger()}
        <Icon icon="tabler:trash" color="red" class="text-2xl" />
      {/snippet}
      <Button.Root
        onclick={onclickDelete}
        class="flex items-center gap-3 px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
      >
        Confirm Delete
      </Button.Root>
    </Dialog>
  </div>
</div>