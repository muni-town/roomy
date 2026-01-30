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
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  let { state, pending, error, idle, children, onChildError }: Props<T> =
    $props();

  function normalizeError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    return "An unexpected error occurred";
  }
</script>

{#if state.status === "idle"}
  {#if idle}
    {@render idle()}
  {/if}
{:else if state.status === "loading"}
  {#if pending}
    {@render pending()}
  {/if}
{:else if state.status === "error"}
  {#if error}
    {@render error({ message: state.message })}
  {/if}
{:else if state.status === "success" && children}
  <svelte:boundary onerror={(e) => onChildError?.(e)}>
    {@render children(state.data)}

    {#snippet failed(e, reset)}
      {#if error}
        {@render error({ message: normalizeError(e), reset })}
      {/if}
    {/snippet}
  </svelte:boundary>
{/if}
