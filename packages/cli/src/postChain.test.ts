import { describe, expect, test } from "bun:test";
import { PostChain, errorText } from "./postChain.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Coverage for the responder's streamed thinking-chunk chain.
 *
 * A chunk post can time out (XRPC). When its rejection reaches the chain's last
 * link unhandled, Node treats it as an unhandled rejection and kills the
 * process — taking the whole `roomy-bridge | respond` pipeline down via EPIPE
 * and losing the in-flight answer. A chain whose links stay rejected also skips
 * every subsequent chunk's `.then`, so one real timeout gets logged as N
 * failures.
 */
describe("PostChain", () => {
  test("a failing post does not reject the chain or crash the process", async () => {
    const posts: number[] = [];
    const logged: string[] = [];
    const chain = new PostChain((m) => logged.push(m));

    chain.push(async () => {
      posts.push(1);
      throw new Error("XRPC ... timed out after 20000ms");
    });

    // The whole point: drain() must resolve even though the post threw.
    await expect(chain.drain()).resolves.toBeUndefined();
    expect(posts).toEqual([1]);
    expect(chain.failureCount()).toBe(1);
    expect(errorText(chain.firstError())).toContain("timed out after 20000ms");
    expect(logged[0]).toContain("timed out after 20000ms");
  });

  test("posts after a failure still run (each chunk is attempted once)", async () => {
    const attempted: number[] = [];
    const chain = new PostChain(() => {});

    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      chain.push(async () => {
        attempted.push(n);
        throw new Error(`timeout ${n}`);
      });
    }

    await chain.drain();
    // Every chunk must be attempted exactly once.
    expect(attempted).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(chain.failureCount()).toBe(7);
    // The FIRST error is the original timeout, not a later re-run of it.
    expect(errorText(chain.firstError())).toBe("timeout 1");
  });

  test("posts run serially, in order", async () => {
    const order: string[] = [];
    const chain = new PostChain(() => {});
    chain.push(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    chain.push(async () => {
      order.push("b");
    });
    await chain.drain();
    expect(order).toEqual(["a", "b"]);
  });

  test("drain waits for work pushed while draining", async () => {
    const chain = new PostChain(() => {});
    let done = false;
    chain.push(async () => {
      await tick();
      // A late chunk arriving mid-drain is still awaited by the same drain().
      chain.push(async () => {
        done = true;
      });
    });
    await chain.drain();
    expect(done).toBe(true);
  });

  test("a healthy chain reports no failures", async () => {
    const seen: string[] = [];
    const chain = new PostChain(() => {
      throw new Error("logger must not be called on success");
    });
    chain.push(async () => {
      seen.push("chunk");
    });
    await chain.drain();
    expect(seen).toEqual(["chunk"]);
    expect(chain.failureCount()).toBe(0);
    expect(chain.firstError()).toBeUndefined();
  });

  test("an empty chain drains immediately", async () => {
    const chain = new PostChain();
    await expect(chain.drain()).resolves.toBeUndefined();
    expect(chain.failureCount()).toBe(0);
  });
});
