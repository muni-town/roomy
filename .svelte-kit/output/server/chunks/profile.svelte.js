import "@automerge/automerge";
import "base32-encode";
import "base32-decode";
import { o as on } from "./events.js";
import { s as set, a2 as effect_tracking, q as get, a3 as source, a4 as render_effect, a5 as untrack, a6 as tick } from "./index.js";
import "@atproto/oauth-client-browser";
import "@atproto/api";
import "@automerge/automerge-repo-storage-indexeddb";
import "@atproto/lexicon";
function isAnnouncement(message) {
  return message.kind !== void 0;
}
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
    }
  });
  return entry;
}
export {
  getProfile as g,
  isAnnouncement as i,
  outerWidth as o
};
