<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconHashtag, IconDocument } from "../../icons/index";

  type Variant = "channel" | "page";

  let {
    variant,
    name,
    href,
    active = false,
    hasUnreadDot = false,
    hasUnread = false,
    icon,
    trailing,
    children,
  }: {
    variant: Variant;
    name: string;
    href?: string;
    active?: boolean;
    /** Show the small accent dot indicating unread messages */
    hasUnreadDot?: boolean;
    /** Whether the channel/thread has unread messages (controls text contrast) */
    hasUnread?: boolean;
    /** Optional override for the leading icon */
    icon?: Snippet;
    /** Optional trailing content (e.g., an edit button) */
    trailing?: Snippet;
    /** Optional children to render below the row (e.g., linked rooms) */
    children?: Snippet;
  } = $props();
</script>

{#if variant === "channel"}
  <div class="inline-flex min-w-0 flex-col w-full max-w-full shrink">
    <div
      class="inline-flex items-center justify-between gap-2 w-full min-w-0 group"
    >
      <Button
        {href}
        variant="ghost"
        class="relative w-full justify-start min-w-0 px-2.5"
        data-current={active}
      >
        {#if icon}
          {@render icon()}
        {:else}
          <IconHashtag class={["shrink-0", !hasUnread && !active && "text-base-500 dark:text-base-500"]} />
        {/if}
        {#if hasUnreadDot}
          <div
            aria-label="Has unread messages"
            class="size-1.25 rounded-full bg-accent-500 absolute left-2.5 top-1.5"
          ></div>
        {/if}
        <span
          class={[
            "truncate whitespace-nowrap overflow-hidden min-w-0",
            hasUnread || active ? "font-semibold" : "font-normal",
            !hasUnread && !active && "text-base-500 dark:text-base-500",
          ]}>{name}</span
        >
      </Button>
      {#if trailing}{@render trailing()}{/if}
    </div>

    {#if children}
      <div class={"w-full max-w-full shrink min-w-0"}>
        {@render children()}
      </div>
    {/if}
  </div>
{:else if variant === "page"}
  <div
    class="inline-flex items-center justify-between gap-2 w-full min-w-0 group"
  >
    <Button
      {href}
      variant="ghost"
      class={["w-full justify-start min-w-0 font-semibold py-1 px-2.5"]}
      data-current={active}
    >
      {#if icon}
        {@render icon()}
      {:else}
        <IconDocument class="shrink-0" />
      {/if}
      <span class="truncate min-w-0 whitespace-nowrap overflow-hidden"
        >{name}</span
      >
    </Button>
    {#if trailing}{@render trailing()}{/if}
  </div>
{/if}
