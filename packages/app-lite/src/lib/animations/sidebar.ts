/**
 * Sidebar animation utilities using anime.js.
 *
 * Provides pre-configured animation functions for sidebar transitions:
 * - Server bar expand/collapse
 * - Sidebar panel slide in/out
 * - Category and channel item entrance stagger
 * - Active indicator transitions
 * - Drag-and-drop feedback
 */
import { animate, stagger } from "animejs";
import type { JSAnimation, AnimationParams } from "animejs";

// ─── Timing presets ───────────────────────────────────────────────

export const DURATIONS = {
  /** Quick micro-interactions (hover, active dot) */
  micro: 150,
  /** Standard UI transitions (panel slides, collapses) */
  standard: 250,
  /** Expressive transitions (staggered list entrance) */
  expressive: 400,
  /** Page-level transitions */
  page: 600,
} as const;

export const EASINGS = {
  /** Smooth deceleration for elements entering the viewport */
  enter: "easeOutCubic" as const,
  /** Smooth acceleration for elements leaving the viewport */
  exit: "easeInCubic" as const,
  /** Bouncy, playful feel for emphasis */
  spring: "easeOutElastic(0.6, 0.4)" as const,
  /** Smooth in-and-out for hover micro-interactions */
  standard: "easeInOutCubic" as const,
};

// ─── Server bar animations ──────────────────────────────────────

/**
 * Animate the server bar expanding to wide mode.
 * Returns the anime instance so callers can chain/promise.
 */
export function animateServerBarExpand(
  bar: HTMLElement,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(bar, {
    width: [64, 256],
    opacity: [0.6, 1],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.enter,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

/**
 * Animate the server bar collapsing to compact mode.
 */
export function animateServerBarCollapse(
  bar: HTMLElement,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(bar, {
    width: [256, 64],
    opacity: [1, 0.6],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.exit,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

// ─── Sidebar panel animations ────────────────────────────────────

/**
 * Slide the BigSidebar panel in from the left.
 */
export function animateSidebarIn(
  panel: HTMLElement,
  opts?: { duration?: number; delay?: number; onComplete?: () => void },
): JSAnimation {
  return animate(panel, {
    translateX: [-20, 0],
    opacity: [0, 1],
    duration: opts?.duration ?? DURATIONS.standard,
    delay: opts?.delay ?? 0,
    ease: EASINGS.enter,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

/**
 * Slide the BigSidebar panel out to the left.
 */
export function animateSidebarOut(
  panel: HTMLElement,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(panel, {
    translateX: [0, -20],
    opacity: [1, 0],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.exit,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

// ─── Category / channel list animations ──────────────────────────

/**
 * Staggered entrance for sidebar category items.
 * Each category fades and slides in with a progressive delay.
 */
export function animateCategoriesIn(
  container: HTMLElement,
  opts?: {
    duration?: number;
    stagger?: number;
    from?: "top" | "bottom";
    onComplete?: () => void;
  },
): JSAnimation {
  const children = Array.from(container.children) as HTMLElement[];
  return animate(children, {
    translateY: opts?.from === "bottom" ? [12, 0] : [-12, 0],
    opacity: [0, 1],
    duration: opts?.duration ?? DURATIONS.expressive,
    delay: stagger(opts?.stagger ?? 40, { from: opts?.from ?? "first" }),
    ease: EASINGS.enter,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

/**
 * Staggered entrance for channel items within a category.
 */
export function animateChannelsIn(
  container: HTMLElement,
  opts?: {
    duration?: number;
    stagger?: number;
    onComplete?: () => void;
  },
): JSAnimation {
  const children = Array.from(container.children) as HTMLElement[];
  return animate(children, {
    translateX: [-8, 0],
    opacity: [0, 1],
    duration: opts?.duration ?? DURATIONS.standard,
    delay: stagger(opts?.stagger ?? 30),
    ease: EASINGS.enter,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

// ─── Active indicator ───────────────────────────────────────────

/**
 * Animate the active channel indicator (e.g. a left border bar) sliding
 * to a new position.
 */
export function animateActiveIndicator(
  indicator: HTMLElement,
  targetY: number,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(indicator, {
    translateY: targetY,
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.standard,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

// ─── Drag-and-drop feedback ─────────────────────────────────────

/**
 * Subtle scale-up animation on a dragged item.
 */
export function animateDragStart(
  item: HTMLElement,
  opts?: { scale?: number; duration?: number },
): JSAnimation {
  return animate(item, {
    scale: opts?.scale ?? 1.03,
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    duration: opts?.duration ?? DURATIONS.micro,
    ease: EASINGS.enter,
  } satisfies AnimationParams);
}

/**
 * Restore the dragged item to its original state.
 */
export function animateDragEnd(
  item: HTMLElement,
  opts?: { duration?: number },
): JSAnimation {
  return animate(item, {
    scale: 1,
    boxShadow: "none",
    duration: opts?.duration ?? DURATIONS.micro,
    ease: EASINGS.exit,
  } satisfies AnimationParams);
}

// ─── Mobile sidebar ─────────────────────────────────────────────

/**
 * Slide the mobile sidebar in from the left.
 */
export function animateMobileSidebarIn(
  panel: HTMLElement,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(panel, {
    translateX: ["-100%", 0],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.enter,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

/**
 * Slide the mobile sidebar out to the left.
 */
export function animateMobileSidebarOut(
  panel: HTMLElement,
  opts?: { duration?: number; onComplete?: () => void },
): JSAnimation {
  return animate(panel, {
    translateX: [0, "-100%"],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.exit,
    onComplete: opts?.onComplete,
  } satisfies AnimationParams);
}

// ─── Backdrop fade ──────────────────────────────────────────────

/**
 * Fade in/out the mobile sidebar backdrop.
 */
export function animateBackdrop(
  backdrop: HTMLElement,
  show: boolean,
  opts?: { duration?: number },
): JSAnimation {
  return animate(backdrop, {
    opacity: show ? [0, 1] : [1, 0],
    duration: opts?.duration ?? DURATIONS.standard,
    ease: EASINGS.standard,
  } satisfies AnimationParams);
}
