import type { TaskPriority } from "./types";

/***
 * AsyncChannel is a producer-consumer queue that bridges synchronous push operations with
 * asynchronous iteration. Producers call `push(item)` to add data to a queue, which can
 * separatedly be processed by the consumer by iterating over the instance with `for await..of`
 * syntax. An instance of AsyncChannel can 'accumulate' items and act as a buffer, enabling
 * processing (consumption) to happen at a different rate to production, and for both to continue
 * indefinitely as long as the loop runs or it hasn't been closed with `finish` - hence, 'channel'.
 *
 * If the `for await..of` loop gets to the end of the queue and there is nothing left, it pushes a
 * resolver to the 'resolvers' queue. This makes it possible to have multiple concurrent consumers,
 * ready to compute when work comes in.
 *
 * A new update adds priority queuing. Now, items pushed to the queue can optionally be marked as
 * 'background' priority - this simply means that it will only be delivered to the iterator once
 * the normal queue is empty, so as not to block more urgent work.ß
 *
 * A note on syntax:
 *
 * AsyncChannel implements the 'async iterable' protocol, enabling `for await...of`
 * syntax for instances (note the distinction between *iterable* and *iterator*):
 *
 * > An object implements the async iterable protocol when it implements the following methods:
 * > [Symbol.asyncIterator]()
 * >   A zero-argument function that returns an object, conforming to the async iterator protocol.
 * Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#the_async_iterator_and_async_iterable_protocols
 *
 * An async iterator implements `next()`, `return(value)` and `throw(exception)`, which all return
 * Promises. The method below, `async *[Symbol.asyncIterator]() {...}` uses async generator syntax,
 * which desugars to return an async iterator with these methods. This is the same as how synchronous
 * generator functions desugar to a sync Iterator with the same methods, just not wrapped in Promises.
 * Note that the `#next()` method that is manually defined is just a helper method: it's not called
 * 'next' in order to conform to the protocol, which as well as the other methods would require the
 * Promise resolving to satisfy `interface IteratorResult<T> { value: T; done: boolean }`. By contrast,
 * the desugared `async *` generator auto-implements `next()`, `return(value)` and `throw(exception)`.
 */
export class AsyncChannel<T> {
  #queue: (T | typeof END)[] = [];
  #backgroundQueue: (T | typeof END)[] = [];
  #resolvers: ((next: T | typeof END) => void)[] = [];

  push(item: T | typeof END, priority: TaskPriority = "normal"): void {
    const resolver = this.#resolvers.shift();
    if (resolver) {
      resolver(item);
    } else if (priority === "normal") {
      this.#queue.push(item);
    } else if (priority === "background") {
      this.#backgroundQueue.push(item);
    }
  }

  finish(): void {
    this.push(END);
  }

  static single<T>(item: T): AsyncChannel<T> {
    const channel = new AsyncChannel<T>();
    channel.push(item);
    channel.finish();
    return channel;
  }

  async #next(): Promise<T | typeof END> {
    const inQueue = this.#queue.shift();
    if (inQueue) {
      return inQueue;
    }

    const inBackgroundQueue = this.#backgroundQueue.shift();
    if (inBackgroundQueue) {
      return inBackgroundQueue;
    }

    return new Promise((r) => this.#resolvers.push(r));
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = await this.#next();
      if (next == END) {
        return;
      } else {
        yield next;
      }
    }
  }
}

const END = Symbol();
