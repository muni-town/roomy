<script lang="ts">
  import Icon from "@iconify/svelte";
  import type { Ulid, Thread } from "$lib/schemas/types";
  import { decodeTime } from "ulidx";
  import { formatDistanceToNowStrict } from "date-fns";
  import { Button, Dialog, Separator } from "bits-ui";
  import { fade } from "svelte/transition";

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
  <Button.Root {onclick} class="flex gap-4 items-center grow cursor-pointer">
    <h1 class="text-xl font-semibold">{thread.title}</h1>
    <time class="text-sm text-gray-300">Latest: {formatDistanceToNowStrict(latest)} ago</time>
  </Button.Root>
  <div class="flex gap-4 items-center">
    <p class="flex gap-2 items-center">
      {thread.timeline.length}
      <Icon icon="tabler:message" class="text-2xl" />
    </p>
    <Dialog.Root> 
      <Dialog.Trigger class="hover:scale-105 active:scale-95 transition-all duration-150 cursor-pointer">
        <Icon icon="tabler:trash" color="red" class="text-2xl" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          transition={fade}
          transitionConfig={{ duration: 150 }}
          class="fixed inset-0 z-50 bg-black/80"
        />
        <Dialog.Content
          class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
        >
          <Dialog.Title
            class="text-bold font-bold text-xl flex items-center justify-center gap-4"
          >
            <Icon icon="ri:alarm-warning-fill" color="red" class="text-2xl" />
            <span> Delete Thread </span>
            <Icon icon="ri:alarm-warning-fill" color="red" class="text-2xl" />
          </Dialog.Title>
          <Separator.Root class="border border-white" />
          <div class="flex flex-col items-center gap-4">
            <p>
              The thread will be unrecoverable once deleted.
            </p>
            <Button.Root
              onclick={onclickDelete}
              class="flex items-center gap-3 px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
            >
              Confirm Delete
            </Button.Root>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>
</div>