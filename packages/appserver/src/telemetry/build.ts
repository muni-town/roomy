/**
 * Build identity for log records and health checks.
 *
 * Resolution chain: `BUILD_ID` (baked by Dockerfile.appserver's RUNTIME stage
 * as the 8-char SHA from `RAILWAY_GIT_COMMIT_SHA`) → `RAILWAY_GIT_COMMIT_SHA`
 * (provided by the platform when the deploy came from git) → `"unknown"`
 * (local dev, or a deploy carrying no git metadata).
 *
 * The Dockerfile must declare the pair in the runtime stage too: Docker does
 * not propagate `ARG`/`ENV` across stages, so a value set only in the build
 * stage is invisible to the process that actually runs.
 *
 * An empty or whitespace-only value counts as ABSENT, not as an identity:
 * `??` does not fall through on `""`, so a raw chain would put an empty
 * `build_id` on the wire — present, meaningless, and indistinguishable from
 * a real value to every consumer downstream.
 *
 * Called once per log record; the chain is written out inline so it allocates
 * nothing (no array, no iterator) on the hot path.
 */
export function resolveBuildId(): string {
  const baked = process.env.BUILD_ID?.trim();
  if (baked) return baked;
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (sha) return sha;
  return "unknown";
}

/**
 * Deployment environment name: `APP_ENV` → `RAILWAY_ENVIRONMENT_NAME` →
 * `"unknown"`, lowercased.
 *
 * Same absent-not-empty rule as `resolveBuildId`: a trimmed value that is
 * falsy falls through, so a whitespace-only variable can never become an
 * empty `env` label. Lowercasing folds `Staging` and `staging` into one
 * stream — Loki labels are exact-match, and two casings of one environment
 * is the split this whole mechanism exists to prevent.
 *
 * Called once per log record; the chain is inline so it allocates nothing
 * beyond the trim/lowercase on the value that survives.
 */
export function resolveEnvName(env: NodeJS.ProcessEnv = process.env): string {
  const appEnv = env.APP_ENV?.trim();
  if (appEnv) return appEnv.toLowerCase();
  const railwayEnv = env.RAILWAY_ENVIRONMENT_NAME?.trim();
  if (railwayEnv) return railwayEnv.toLowerCase();
  return "unknown";
}
