export function withTimeoutCallback<T>(
  promise: Promise<T>,
  callback: () => void,
  timeoutMs: number = 5000,
): Promise<T> {
  let resolved = false;

  const timeoutId = setTimeout(() => {
    if (!resolved) {
      callback();
    }
  }, timeoutMs);

  return promise.finally(() => {
    resolved = true;
    clearTimeout(timeoutId);
  });
}

export function withTimeoutWarning<T>(promise: Promise<T>, message: string) {
  return withTimeoutCallback(promise, () => console.warn(message), 5000);
}
