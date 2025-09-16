<script lang="ts">
  import { navigate, navigateSync } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { Tooltip } from "@fuxui/base";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";

  type Props = {
    name?: string;
    avatar?: string;
    id: string;
    hasJoined?: boolean;
  };

  const { name, avatar, id, hasJoined = true }: Props = $props();

  let isActive = $derived(page.params.space == id);
</script>

<Tooltip
  text={name}
  delayDuration={0}
  contentProps={{ side: "right", sideOffset: 5 }}
>
  {#snippet child({ props })}
    <a
      {...props}
      href={navigateSync({ space: id })}
      class={[
        "size-10 rounded-full relative group",
        isActive
          ? "outline-4 outline-accent-500 cursor-default"
          : "cursor-pointer",
        "transition-all duration-200 bg-base-300",
      ]}
      onmousedown={() => {
        if (isActive) return;
        navigate({ space: id });
      }}
      onclick={(e) => {
        if (!isActive) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        class={[
          "flex items-center justify-center overflow-hidden",
          !hasJoined && "filter grayscale",
        ]}
      >
        <SpaceAvatar imageUrl={avatar} {id} size={40} />
      </div>
    </a>
  {/snippet}
</Tooltip>
