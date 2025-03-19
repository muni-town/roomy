import { m as f, a0 as w, ax as q, $ as x } from "./BMAj9zKA.js";
function _(e, r, n) {
  if (e == null) return r(void 0), n && n(void 0), f;
  const t = w(() => e.subscribe(r, n));
  return t.unsubscribe ? () => t.unsubscribe() : t;
}
const b = [];
function z(e, r) {
  return { subscribe: A(e, r).subscribe };
}
function A(e, r = f) {
  let n = null;
  const t = /* @__PURE__ */ new Set();
  function o(u) {
    if (q(e, u) && (e = u, n)) {
      const i = !b.length;
      for (const s of t) s[1](), b.push(s, e);
      if (i) {
        for (let s = 0; s < b.length; s += 2) b[s][0](b[s + 1]);
        b.length = 0;
      }
    }
  }
  function a(u) {
    o(u(e));
  }
  function l(u, i = f) {
    const s = [u, i];
    return t.add(s), t.size === 1 && (n = r(o, a) || f), u(e), () => {
      t.delete(s), t.size === 0 && n && (n(), n = null);
    };
  }
  return { set: o, update: a, subscribe: l };
}
function B(e, r, n) {
  const t = !Array.isArray(e), o = t ? [e] : e;
  if (!o.every(Boolean)) throw new Error("derived() expects stores as input, got a falsy value");
  const a = r.length < 2;
  return z(n, (l, u) => {
    let i = false;
    const s = [];
    let d = 0, p = f;
    const y = () => {
      if (d) return;
      p();
      const c = r(t ? s[0] : s, l, u);
      a ? l(c) : p = typeof c == "function" ? c : f;
    }, h = o.map((c, g) => _(c, (m) => {
      s[g] = m, d &= ~(1 << g), i && y();
    }, () => {
      d |= 1 << g;
    }));
    return i = true, y(), function() {
      x(h), p(), i = false;
    };
  });
}
function E(e) {
  return { subscribe: e.subscribe.bind(e) };
}
function S(e) {
  let r;
  return _(e, (n) => r = n)(), r;
}
export {
  E as a,
  B as d,
  S as g,
  z as r,
  _ as s,
  A as w
};
