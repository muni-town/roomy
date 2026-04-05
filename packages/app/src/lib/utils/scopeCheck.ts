/**
 * Compare granted OAuth scopes against required scopes.
 * Returns the list of missing scopes, or null if all required scopes are present.
 * Additive-only: removing a scope from required won't trigger re-auth.
 */
export function checkScopeMismatch(
  grantedScope: string,
  requiredScope: string,
): string[] | null {
  const granted = new Set(grantedScope.split(" ").filter(Boolean));
  const required = requiredScope.split(" ").filter(Boolean);
  const missing = required.filter((s) => !granted.has(s));
  return missing.length > 0 ? missing : null;
}
