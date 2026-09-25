/**
 * Build identity for app-lite.
 *
 * A deployed client bundle must be able to name the commit it was built from,
 * otherwise nothing can tie the running code to a revision — a change can be
 * merged and "deployed" while the served bundle is still the previous build.
 * SvelteKit's `/_app/version.json` is a build *timestamp* with no commit
 * mapping, so it identifies nothing about the code being served.
 *
 * `resolveBuildId` is called once, in `vite.config.ts`, and its result reaches
 * the outside world two ways that cannot disagree: inlined into the JS bundle
 * as `__BUILD_ID__`, and served as `/build.json` from that same value.
 *
 * The chain matches the appserver's and discord-bridge's, so the three
 * services' `build_id` values are comparable in one query: `BUILD_ID` (the
 * 8-char SHA from `RAILWAY_GIT_COMMIT_SHA`; `Dockerfile.app-lite` sets it in
 * the image, `scripts/build-prod.sh` for out-of-image builds) →
 * `RAILWAY_GIT_COMMIT_SHA` (the platform injects this) → `"unknown"`.
 *
 * An empty or whitespace-only value counts as ABSENT, not as an identity. The
 * Dockerfile's `ENV BUILD_ID=${RAILWAY_GIT_COMMIT_SHA%...}` materialises an
 * empty string when the build arg is absent, and `??` does not fall through on
 * `""` — a raw chain would bake an empty id into every bundle: present,
 * meaningless, and indistinguishable from a real value downstream.
 *
 * Deliberately free of `__BUILD_ID__` so it is importable (and unit-testable)
 * outside a Vite build, where that define does not exist.
 */

/** The `/build.json` payload — the wire contract for "what is deployed". */
export interface BuildManifest {
  /** Commit the bundle was built from, or `"unknown"` when the build carried
   *  no git metadata at all (see the warning `scripts/build-prod.sh` prints). */
  commit: string;
  /** `package.json` version at build time (matches `__APP_VERSION__`). */
  version: string;
  /** ISO-8601 build timestamp — the ordering key for the deploy-revision audit
   *  when a build legitimately has no commit (a rebuild of the same source, or
   *  a local build). */
  built_at: string;
}

/**
 * Resolve the build identity from an environment.
 *
 * `env` is the process environment during the build; passing it in keeps the
 * rule testable without mutating global state.
 */
export function resolveBuildId(
  env: Record<string, string | undefined>,
): string {
  const baked = env.BUILD_ID?.trim();
  if (baked) return baked;
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (sha) return sha;
  return "unknown";
}
