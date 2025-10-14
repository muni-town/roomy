export const END = Symbol();
export class AsyncChannel<T> {
  #queue: (T | typeof END)[] = [];
  #resolvers: ((next: T | typeof END) => void)[] = [];

  push(item: T | typeof END): void {
    const resolver = this.#resolvers.shift();
    if (resolver) {
      resolver(item);
    } else {
      this.#queue.push(item);
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

  async next(): Promise<T | typeof END> {
    const inQueue = this.#queue.shift();
    if (inQueue) {
      return inQueue;
    } else {
      return new Promise((r) => this.#resolvers.push(r));
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = await this.next();
      if (next == END) {
        return;
      } else {
        yield next;
      }
    }
  }
}
