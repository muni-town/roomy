<script lang="ts">
  import { setContext } from "svelte";
  import { outerWidth } from "svelte/reactivity/window";
  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import { Button } from "bits-ui";
  import { g } from "$lib/global.svelte";
  import { Channel, Message, Timeline } from "@roomy-chat/sdk";
  import ToggleNavigation from "./ToggleNavigation.svelte";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  // thread maker
  let isThreading = $state({ value: false });
  let selectedMessages: Message[] = $state([]);
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message: Message) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (message: Message) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });
</script>

<header class="dz-navbar">
  <div class="dz-navbar-start flex gap-4">
    {#if g.channel}
      <ToggleNavigation />

      <h4
        class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}
      >
        <span class="flex gap-2 items-center">
          <Icon
            icon={g.channel instanceof Channel
              ? "basil:comment-solid"
              : "material-symbols:thread-unread-rounded"}
          />
          Links
        </span>
      </h4>
    {/if}
  </div>
</header>
<div class="dz-divider my-0"></div>

{#if g.space && g.channel}
  <ChatArea timeline={g.channel.forceCast(Timeline)} />
  <div class="flex items-center grow flex-col">
    <Button.Root disabled class="w-full dz-btn"
      >Broadcast Only Thread</Button.Root
    >
  </div>
{/if}
