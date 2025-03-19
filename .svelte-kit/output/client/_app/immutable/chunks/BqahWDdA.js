import { a3 as s, u as i, Z as t, a0 as u, O as _ } from "./BMAj9zKA.js";
import { l as m } from "./DIeogL5L.js";
function p(e) {
  t === null && s(), m && t.l !== null ? d(t).m.push(e) : i(() => {
    const n = u(e);
    if (typeof n == "function") return n;
  });
}
function b(e) {
  t === null && s(), p(() => () => u(e));
}
function v(e, n, { bubbles: c = false, cancelable: a = false } = {}) {
  return new CustomEvent(e, { detail: n, bubbles: c, cancelable: a });
}
function k() {
  const e = t;
  return e === null && s(), (n, c, a) => {
    const o = e.s.$$events?.[n];
    if (o) {
      const l = _(o) ? o.slice() : [o], r = v(n, c, a);
      for (const f of l) f.call(e.x, r);
      return !r.defaultPrevented;
    }
    return true;
  };
}
function d(e) {
  var n = e.l;
  return n.u ??= { a: [], b: [], m: [] };
}
export {
  b as a,
  k as c,
  p as o
};
