/**
 * Race a promise against a timeout. Resolves/rejects with the underlying
 * promise, or rejects with a timeout error after `ms`. The underlying promise
 * is NOT cancelled (Promises aren't cancellable) — it keeps running and may
 * eventually settle, but the caller is unblocked either way. Use this to bound
 * operations that have no built-in timeout (Leaf socket.io RPCs, drains, etc.)
 * so a dead peer can't hang a caller indefinitely.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms waiting on ${label}`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}