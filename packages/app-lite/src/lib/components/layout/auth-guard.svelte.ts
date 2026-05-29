/**
 * Reactive guard that controls whether the root layout shows the login modal.
 *
 * Routes that don't require authentication can opt out:
 *
 * ```svelte
 * <script>
 *   import { requireAuth } from "$lib/components/layout/auth-guard.svelte";
 *   requireAuth.value = false;
 * </script>
 * ```
 *
 * Defaults to `true`. Should be reset on navigation by the root layout.
 */
export const requireAuth = $state({ value: true });
