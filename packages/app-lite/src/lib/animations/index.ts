/**
 * Animation utilities for app-lite.
 *
 * Uses anime.js for smooth, performant UI transitions.
 *
 * ## Quick Start
 *
 * ```svelte
 * <script lang="ts">
 *   import { animeAction } from "$lib/animations";
 *   import { DURATIONS, EASINGS } from "$lib/animations";
 *
 *   let fadeIn = $state({
 *     opacity: [0, 1],
 *     translateY: [10, 0],
 *     duration: DURATIONS.standard,
 *     ease: EASINGS.enter,
 *   });
 * </script>
 *
 * <div use:animeAction={fadeIn}>Hello</div>
 * ```
 *
 * For sidebar-specific animations:
 *
 * ```svelte
 * <script lang="ts">
 *   import { onMount } from "svelte";
 *   import { animateCategoriesIn } from "$lib/animations";
 *
 *   let container: HTMLElement;
 *
 *   onMount(() => {
 *     animateCategoriesIn(container);
 *   });
 * </script>
 *
 * <div bind:this={container}>
 *   {#each categories as cat}
 *     <div>{cat.name}</div>
 *   {/each}
 * </div>
 * ```
 */
export {
  animate,
  stagger,
  createTimeline,
  animeAction,
  animeEnter,
  animeStagger,
  useAnime,
  animeTransition,
  animeSlide,
  animeScale,
} from "./anime.svelte";
export type { AnimationParams, JSAnimation, TimelineParams, TimerParams } from "animejs";

export {
  DURATIONS,
  EASINGS,
  animateServerBarExpand,
  animateServerBarCollapse,
  animateSidebarIn,
  animateSidebarOut,
  animateCategoriesIn,
  animateChannelsIn,
  animateActiveIndicator,
  animateDragStart,
  animateDragEnd,
  animateMobileSidebarIn,
  animateMobileSidebarOut,
  animateBackdrop,
} from "./sidebar";
