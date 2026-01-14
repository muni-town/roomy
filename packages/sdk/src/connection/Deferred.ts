/**
 * A Promise that can be resolved or rejected externally.
 *
 * Useful for coordinating async operations where the resolution
 * happens in a different context than the creation.
 */
export class Deferred<T = void> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
