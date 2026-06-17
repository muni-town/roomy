/**
 * Svelte 5 action wrappers for anime.js.
 *
 * Provides `use:anime` actions and reactive helpers that integrate
 * anime.js with Svelte 5's runes and lifecycle.
 *
 * Usage:
 * ```svelte
 * <script lang="ts">
 *   import { animeAction } from "$lib/animations/anime.svelte";
 *   import type { AnimationParams } from "animejs";
 *
 *   let params = $state<AnimationParams>({
 *     translateX: [0, 100],
 *     duration: 800,
 *     ease: "easeOutElastic",
 *   });
 * </script>
 *
 * <div use:animeAction={params}>Animate me</div>
 * ```
 *
 * For reactive animations tied to state changes, use `$effect`:
 * ```svelte
 * <script lang="ts">
 *   import { animate } from "animejs";
 *   import { onMount } from "svelte";
 *
 *   let element = $state<HTMLElement | null>(null);
 *   let isOpen = $state(false);
 *
 *   $effect(() => {
 *     if (element && isOpen) {
 *       animate(element, { translateY: [20, 0], opacity: [0, 1], duration: 300 });
 *     }
 *   });
 * </script>
 *
 * <div bind:this={element}>Content</div>
 * ```
 */
import { animate, stagger } from "animejs";
import type { AnimationParams, JSAnimation } from "animejs";
import type { TransitionConfig } from "svelte/transition";

export type { AnimationParams, JSAnimation, TimelineParams, TimerParams } from "animejs";

/**
 * Re-export key anime.js functions for direct use.
 * Prefer the action-based approach for element-bound animations.
 */
export { animate, stagger, createTimeline } from "animejs";

/**
 * A Svelte `use:` action that applies an anime.js animation to an element.
 *
 * The animation replays whenever the params object changes (by reference).
 * Pass `{ autoplay: false }` and call `.play()` manually if you need
 * imperative control.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { animeAction } from "$lib/animations/anime.svelte";
 *
 *   let fadeIn = $state({ opacity: [0, 1], translateY: [10, 0], duration: 400, ease: "easeOutCubic" });
 * </script>
 *
 * <div use:animeAction={fadeIn}>Hello</div>
 * ```
 */
export function animeAction(
  node: HTMLElement | SVGElement,
  params: AnimationParams,
) {
  let instance = animate(node, params);

  return {
    update(newParams: AnimationParams) {
      instance.pause();
      instance.seek(0);
      instance = animate(node, newParams);
    },
    destroy() {
      instance.pause();
    },
  };
}

/**
 * A Svelte `use:` action that applies an anime.js animation to an element
 * only on initial mount (enter animation). Does not re-trigger on param changes.
 *
 * @example
 * ```svelte
 * <div use:animeEnter={{ translateY: [20, 0], opacity: [0, 1], duration: 300, ease: "easeOutCubic" }}>
 *   Stagger in
 * </div>
 * ```
 */
export function animeEnter(
  node: HTMLElement | SVGElement,
  params: AnimationParams,
) {
  const instance = animate(node, params);
  return {
    destroy() {
      instance.pause();
    },
  };
}

/**
 * A Svelte `use:` action for stagger animations on a parent container.
 * Animates each child element with a stagger delay.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { animeStagger, stagger } from "$lib/animations/anime.svelte";
 * </script>
 *
 * <ul use:animeStagger={{ translateY: [12, 0], opacity: [0, 1], duration: 400, delay: stagger(60) }}>
 *   <li>Item 1</li>
 *   <li>Item 2</li>
 *   <li>Item 3</li>
 * </ul>
 * ```
 */
export function animeStagger(
  node: HTMLElement | SVGElement,
  params: AnimationParams,
) {
  const children = Array.from(node.children) as HTMLElement[];
  const instance = animate(children, params);

  return {
    update(newParams: AnimationParams) {
      instance.pause();
      const newChildren = Array.from(node.children) as HTMLElement[];
      animate(newChildren, newParams);
    },
    destroy() {
      instance.pause();
    },
  };
}

/**
 * Reactive animation helper for Svelte 5 runes.
 * Returns the JSAnimation instance so callers can chain/promise.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useAnime } from "$lib/animations/anime.svelte";
 *
 *   let element = $state<HTMLElement | null>(null);
 *   let isOpen = $state(false);
 *
 *   $effect(() => {
 *     if (!element) return;
 *     useAnime(element, {
 *       scale: isOpen ? [0.95, 1] : [1, 0.95],
 *       opacity: isOpen ? [0, 1] : [1, 0],
 *       duration: 200,
 *       ease: "easeOutCubic",
 *     });
 *   });
 * </script>
 *
 * <div bind:this={element}>Content</div>
 * ```
 */
export function useAnime(
  target: HTMLElement | SVGElement | HTMLElement[] | SVGElement[] | NodeListOf<HTMLElement>,
  params: AnimationParams,
): JSAnimation {
  return animate(target, params);
}

// ─── Svelte transition helpers ───────────────────────────────────

/**
 * A Svelte `transition:` function powered by anime.js.
 *
 * Creates an anime.js animation with `autoplay: false`, then drives it
 * via Svelte's `tick(t, u)` callback. This gives you both enter and exit
 * animations through Svelte's built-in transition system.
 *
 * Based on Brandon Ma's approach:
 * https://brandonma.dev/blog/animejs-svelte/#transitions
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { animeTransition } from "$lib/animations/anime.svelte";
 *
 *   let items = $state([1, 2, 3]);
 * </script>
 *
 * {#each items as item (item)}
 *   <li transition:animeTransition={{ duration: 300 }}>
 *     {item}
 *   </li>
 * {/each}
 * ```
 */
export function animeTransition(
  node: HTMLElement | SVGElement,
  params: AnimationParams & { duration?: number } = {},
): TransitionConfig {
  const { duration = 300, ...animParams } = params;

  const animation = animate(node, {
    ...animParams,
    autoplay: false,
    duration,
  });

  return {
    duration,
    tick(t: number, _u: number) {
      animation.seek(t * duration);
    },
  };
}

/**
 * A Svelte `transition:` function for a slide+fade entrance/exit using anime.js.
 *
 * @example
 * ```svelte
 * <div transition:animeSlide={{ x: [30, 0], opacity: [0, 1], duration: 250 }}>
 *   Slides and fades in/out
 * </div>
 * ```
 */
export function animeSlide(
  node: HTMLElement | SVGElement,
  params: { duration?: number; x?: number; y?: number } = {},
): TransitionConfig {
  const { duration = 250, x = 20, y = 0 } = params;

  const animation = animate(node, {
    translateX: [x, 0],
    translateY: [y, 0],
    opacity: [0, 1],
    autoplay: false,
    duration,
    ease: "easeOutCubic",
  });

  return {
    duration,
    tick(t: number, _u: number) {
      animation.seek(t * duration);
    },
  };
}

/**
 * A Svelte `transition:` function for a scale+fade entrance/exit using anime.js.
 *
 * @example
 * ```svelte
 * <div transition:animeScale={{ from: 0.95, duration: 200 }}>
 *   Scales and fades in/out
 * </div>
 * ```
 */
export function animeScale(
  node: HTMLElement | SVGElement,
  params: { duration?: number; from?: number } = {},
): TransitionConfig {
  const { duration = 200, from = 0.95 } = params;

  const animation = animate(node, {
    scale: [from, 1],
    opacity: [0, 1],
    autoplay: false,
    duration,
    ease: "easeOutCubic",
  });

  return {
    duration,
    tick(t: number, _u: number) {
      animation.seek(t * duration);
    },
  };
}
