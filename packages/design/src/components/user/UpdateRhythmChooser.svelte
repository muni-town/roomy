<script lang="ts" module>
  /**
   * The four notification "update rhythms" — the shared copy used in both the
   * join flow (this chooser) and the per-user notification settings. The emoji
   * + label + one-line behaviour come from the web-push plan's user-facing
   * table, reused verbatim so the two surfaces never drift.
   */
  export type RhythmLevel = "silent" | "quiet" | "engaged" | "busy";

  export interface RhythmOption {
    value: RhythmLevel;
    emoji: string;
    label: string;
    /** One-line behaviour summary shown under the label. */
    description: string;
  }

  export const RHYTHM_OPTIONS: readonly RhythmOption[] = [
    {
      value: "silent",
      emoji: "❌",
      label: "Silent",
      description: "No notifications.",
    },
    {
      value: "quiet",
      emoji: "🍃",
      label: "Quiet",
      description: "Only when mentioned. (Coming soon.)",
    },
    {
      value: "engaged",
      emoji: "💌",
      label: "Engaged",
      description: "Mentions, plus occasional prompts for missed conversations.",
    },
    {
      value: "busy",
      emoji: "👀",
      label: "Busy",
      description: "Real-time notification for every new message.",
    },
  ];

  /** Appserver-side default when a user has set no preference. */
  export const DEFAULT_RHYTHM: RhythmLevel = "engaged";
</script>

<script lang="ts">
  import { cn } from "../../utils/index.js";

  let {
    value = $bindable(DEFAULT_RHYTHM),
    onchange,
    horizontal = false,
    name = "rhythm",
  }: {
    /** Currently selected level. Bindable so callers can `bind:value`. */
    value?: RhythmLevel;
    /** Fired with the newly selected level when the user picks one. */
    onchange?: (value: RhythmLevel) => void;
    /** Render options in a horizontal row instead of a vertical list. */
    horizontal?: boolean;
    /** Radio group name. Must be unique per-instance when multiple choosers appear on the same page. */
    name?: string;
  } = $props();

  function select(next: RhythmLevel): void {
    value = next;
    onchange?.(next);
  }
</script>
<div
  class={cn(
    "flex gap-1.5",
    horizontal ? "flex-row flex-wrap" : "flex-col",
  )}
  role="radiogroup"
  aria-label="Update rhythm"
>
  {#each RHYTHM_OPTIONS as option (option.value)}
    <label
      class={cn(
        "rounded-lg border p-3 cursor-pointer transition-colors",
        "border-base-200 dark:border-base-700 hover:bg-base-50 dark:hover:bg-base-800",
        value === option.value
          ? "ring-2 ring-base-900 dark:ring-base-100 bg-base-50 dark:bg-base-800"
          : "",
        horizontal
          ? "flex flex-col items-center justify-center gap-1 min-w-28 flex-1"
          : "flex items-start gap-3",
        )}>
      <input
        type="radio"
        {name}
        value={option.value}
        checked={value === option.value}
        onchange={() => select(option.value)}
        class="sr-only"
      />
      <span class="text-xl leading-none select-none" aria-hidden="true">
        {option.emoji}
      </span>
      <span class={cn("flex flex-col min-w-0", horizontal ? "items-center" : "")}>
        <span class="text-sm font-medium text-base-900 dark:text-base-100">
          {option.label}
        </span>
        <span class="text-xs text-base-500 dark:text-base-400 text-center">
          {option.description}
        </span>
      </span>
    </label>
  {/each}
</div>