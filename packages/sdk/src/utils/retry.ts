export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 5,
    baseDelayMs = 500,
    label = "operation",
  }: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 4000);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
          e,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
