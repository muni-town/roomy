<script lang="ts" module>
  /** 'StateSuspense' component - like React Suspense, but for async
   * state machine-shaped data.
   * Can be used with anything that implements AsyncState.
   * Pass a snippet for success (children), pending and error.
   *   */

  import type { AsyncStateWithIdle } from "@roomy/sdk";

  interface ErrorInfo {
    message: string;
    reset?: () => void; // only present for thrown errors
  }

  export interface Props<T> {
    state: AsyncStateWithIdle<T>;
    pending?: Snippet;
    error?: Snippet<[ErrorInfo]>;
    idle?: Snippet;
    children?: Snippet<[T]>;
    /** Called when a child component throws - useful for logging */
    onChildError?: (error: unknown) => void;
    /** Delay in ms before showing loading state (prevents flicker for fast queries). Default: 0 */
    loadingDelay?: number;
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  // Alias 'state' to 'asyncState' to avoid conflict with $state rune
  let {
    state: asyncState,
    pending,
    error,
    idle,
    children,
    onChildError,
    loadingDelay = 0,
  }: Props<T> = $props();

  // Delay showing loading to prevent flicker for fast queries
  let showLoading = $state(loadingDelay === 0);
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (asyncState.status === "loading") {
      if (loadingDelay === 0) {
        showLoading = true;
      } else {
        loadingTimer = setTimeout(() => (showLoading = true), loadingDelay);
      }
    } else {
      showLoading = false;
    }
    return () => clearTimeout(loadingTimer);
  });

  function normalizeError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    return "An unexpected error occurred";
  }
</script>

{#if asyncState.status === "idle"}
  {#if idle}
    {@render idle()}
  {/if}
{:else if asyncState.status === "loading"}
  {#if pending && showLoading}
    {@render pending()}
  {/if}
{:else if asyncState.status === "error"}
  {#if error}
    {@render error({ message: asyncState.message })}
  {/if}
{:else if asyncState.status === "success" && children}
  <svelte:boundary onerror={(e) => onChildError?.(e)}>
    {@render children(asyncState.data)}

    {#snippet failed(e, reset)}
      {#if error}
        {@render error({ message: normalizeError(e), reset })}
      {/if}
    {/snippet}
  </svelte:boundary>
{/if}
