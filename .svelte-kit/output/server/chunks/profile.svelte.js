import { o as on } from "./events.js";
import { s as set, a1 as effect_tracking, q as get, a2 as render_effect, a3 as source, a4 as untrack, a5 as tick } from "./index.js";
import { u as user } from "./user.svelte.js";
function increment(source2) {
  set(source2, source2.v + 1);
}
function createSubscriber(start) {
  let subscribers = 0;
  let version = source(0);
  let stop;
  return () => {
    if (effect_tracking()) {
      get(version);
      render_effect(() => {
        if (subscribers === 0) {
          stop = untrack(() => start(() => increment(version)));
        }
        subscribers += 1;
        return () => {
          tick().then(() => {
            subscribers -= 1;
            if (subscribers === 0) {
              stop?.();
              stop = void 0;
            }
          });
        };
      });
    }
  };
}
class ReactiveValue {
  #fn;
  #subscribe;
  /**
   *
   * @param {() => T} fn
   * @param {(update: () => void) => void} onsubscribe
   */
  constructor(fn, onsubscribe) {
    this.#fn = fn;
    this.#subscribe = createSubscriber(onsubscribe);
  }
  get current() {
    this.#subscribe();
    return this.#fn();
  }
}
const outerWidth = new ReactiveValue(
  () => void 0,
  (update) => on(window, "resize", update)
);
let cache = {};
function getProfile(did) {
  if (!cache[did]) {
    cache[did] = { handle: "", avatarUrl: "", new: true };
  }
  const entry = cache[did];
  queueMicrotask(() => {
    if (entry.new == true) {
      entry.new = false;
      if (user.agent) {
        user.agent.getProfile({ actor: did }).then(async (resp) => {
          if (!resp.success) return;
          entry.handle = resp.data.handle;
          entry.avatarUrl = resp.data.avatar || "";
        });
      }
    }
  });
  return entry;
}
export {
  getProfile as g,
  outerWidth as o
};
