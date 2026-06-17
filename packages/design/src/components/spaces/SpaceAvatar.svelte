<script lang="ts">
  import { AvatarMarble } from "svelte-boring-avatars";
  import { IconLoading } from "../../icons/index";
  import { fade } from "svelte/transition";

  let {
    src,
    id,
    name,
    size = 32,
    shape = "circle",
    loading,
    ringVar,
  }: {
    /** Already-resolved image URL. Callers should pre-process atblob:// URIs. */
    src?: string;
    id?: string;
    name?: string;
    size?: number;
    /** Avatar shape. circle (default) or squircle. */
    shape?: "circle" | "squircle";
    loading?: boolean;
    /** CSS variable name for the ring stroke color (e.g. "--avatar-ring"). The variable is set on the parent/button. Defaults to transparent. */
    ringVar?: string;
  } = $props();

  // Track whether the image has failed to load
  let imgError = $state(false);

  // Unique clipPath ID derived from the space id
  const clipPathId = $derived(
    id ? `sq-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}` : undefined,
  );

  const ringColor = $derived(ringVar ? `var(${ringVar}, transparent)` : "transparent");

  // Reset error state when src changes
  $effect(() => {
    src;
    imgError = false;
  });
</script>

<div
  class={`relative bg-base-200 dark:bg-base-900 shrink-0 overflow-hidden ${loading ? "opacity-70" : ""}`}
  style={`width: ${size}px; height: ${size}px;${shape === "squircle" && clipPathId ? ` clip-path: url(#${clipPathId});` : shape === "circle" ? " border-radius: 9999px;" : ""}`}
>
  {#if src && !imgError}
    <img
      {src}
      alt={name}
      class="object-cover object-center h-full w-full"
      onerror={() => (imgError = true)}
    />
  {:else if id}
    {#key id}
      <AvatarMarble name={id} {size} />
    {/key}
  {/if}
  {#if loading}
    <div
      transition:fade={{ duration: 500 }}
      class="z-10 absolute inset-[-5px] flex items-center justify-center"
    >
      <IconLoading
        font-size="1.8em"
        class="text-white stroke-0"
        style="animation: spin 1.3s  cubic-bezier(0.5, 0.2, 0.5, 0.8) infinite; stroke-linecap: round;"
      />
    </div>
  {/if}
</div>

{#if shape === "squircle" && clipPathId}
  <svg
    width="0"
    height="0"
    style="position: absolute; pointer-events: none;"
    aria-hidden="true"
  >
    <defs>
      <clipPath id={clipPathId} clipPathUnits="objectBoundingBox">
        <!-- True superellipse: continuous smooth curve, no straight edges -->
        <path d="M0.5,0 C0.71,0 0.88,0.05 0.94,0.23 C1,0.43 1,0.56 0.94,0.76 C0.88,0.94 0.71,1 0.5,1 C0.28,1 0.11,0.94 0.05,0.76 C0,0.56 0,0.43 0.05,0.23 C0.11,0.05 0.28,0 0.5,0Z" />
      </clipPath>
    </defs>
  </svg>
  <!-- Ring overlay — stroke color controlled by CSS variable set on the parent -->
  <svg
    class="absolute inset-0 pointer-events-none"
    viewBox="0 0 1 1"
    style={`width: ${size}px; height: ${size}px;`}
    aria-hidden="true"
  >
    <path
      d="M0.5,0 C0.71,0 0.88,0.05 0.94,0.23 C1,0.43 1,0.56 0.94,0.76 C0.88,0.94 0.71,1 0.5,1 C0.28,1 0.11,0.94 0.05,0.76 C0,0.56 0,0.43 0.05,0.23 C0.11,0.05 0.28,0 0.5,0Z"
      transform="translate(0.5, 0.5) scale(0.955) translate(-0.5, -0.5)"
      fill="none"
      stroke={ringColor}
      stroke-width="2"
      vector-effect="non-scaling-stroke"
    />
  </svg>
{/if}