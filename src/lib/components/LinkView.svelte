<script lang="ts">
  import { outerWidth } from "svelte/reactivity/window";
  import Icon from "@iconify/svelte";
  import { g } from "$lib/global.svelte";
  import { Channel, Message, Timeline } from "@roomy-chat/sdk";
  import ToggleNavigation from "$lib/components/ToggleNavigation.svelte";
  import LinkPreview from "$lib/components/LinkPreview.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import VirtualScroll from "$lib/components/VirtualScroll.svelte";
  import { Button } from "bits-ui";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  const timeline = g.channel?.forceCast(Timeline)!;
  const messages = derivePromise([], async () =>
    (await timeline.timeline.items())
      .map((x) => x.tryCast(Message))
      .filter((x) => (x && x.softDeleted) || !!x),
  );
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

<VirtualScroll {timeline} items={messages.value}>
  {#snippet children(message)}
    <LinkPreview {message} />
  {/snippet}
</VirtualScroll>
<div class="flex items-center grow flex-col">
  <Button.Root disabled class="w-full dz-btn">Automatted Thread</Button.Root>
</div>
