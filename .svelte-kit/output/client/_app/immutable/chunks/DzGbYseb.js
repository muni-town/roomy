import { w as N, k as x, ae as I, q as h, a4 as H, V as E, C as _, x as p, v as f, y as L, af as T, ag as w, z as V, D as Y, ah as j, ai as F, R as M, J as S, aj as $, l as q, p as z, Z as J, K, a as P } from "./BMAj9zKA.js";
import { a as W, r as C, h as y, i as Z } from "./BSdt-dIf.js";
import { b as B } from "./pDBoOQRd.js";
let n;
function G() {
  n = void 0;
}
function te(t) {
  let e = null, a = h;
  var o;
  if (h) {
    for (e = f, n === void 0 && (n = L(document.head)); n !== null && (n.nodeType !== 8 || n.data !== H); ) n = E(n);
    n === null ? _(false) : n = p(E(n));
  }
  h || (o = document.head.appendChild(N()));
  try {
    x(() => t(o), I);
  } finally {
    a && (_(true), n = f, p(e));
  }
}
let R = true;
function ae(t) {
  R = t;
}
function re(t, e) {
  var a = e == null ? "" : typeof e == "object" ? e + "" : e;
  a !== (t.__t ??= t.nodeValue) && (t.__t = a, t.nodeValue = a + "");
}
function Q(t, e) {
  return O(t, e);
}
function ne(t, e) {
  T(), e.intro = e.intro ?? false;
  const a = e.target, o = h, c = f;
  try {
    for (var r = L(a); r && (r.nodeType !== 8 || r.data !== H); ) r = E(r);
    if (!r) throw w;
    _(true), p(r), V();
    const l = O(t, { ...e, anchor: r });
    if (f === null || f.nodeType !== 8 || f.data !== Y) throw j(), w;
    return _(false), l;
  } catch (l) {
    if (l === w) return e.recover === false && F(), T(), M(a), _(false), Q(t, e);
    throw l;
  } finally {
    _(o), p(c), G();
  }
}
const u = /* @__PURE__ */ new Map();
function O(t, { target: e, anchor: a, props: o = {}, events: c, context: r, intro: l = true }) {
  T();
  var v = /* @__PURE__ */ new Set(), g = (i) => {
    for (var s = 0; s < i.length; s++) {
      var d = i[s];
      if (!v.has(d)) {
        v.add(d);
        var D = Z(d);
        e.addEventListener(d, y, { passive: D });
        var A = u.get(d);
        A === void 0 ? (document.addEventListener(d, y, { passive: D }), u.set(d, 1)) : u.set(d, A + 1);
      }
    }
  };
  g(S(W)), C.add(g);
  var m = void 0, k = $(() => {
    var i = a ?? e.appendChild(N());
    return q(() => {
      if (r) {
        z({});
        var s = J;
        s.c = r;
      }
      c && (o.$$events = c), h && B(i, null), R = l, m = t(i, o) || {}, R = true, h && (K.nodes_end = f), r && P();
    }), () => {
      for (var s of v) {
        e.removeEventListener(s, y);
        var d = u.get(s);
        --d === 0 ? (document.removeEventListener(s, y), u.delete(s)) : u.set(s, d);
      }
      C.delete(g), i !== a && i.parentNode?.removeChild(i);
    };
  });
  return b.set(m, k), m;
}
let b = /* @__PURE__ */ new WeakMap();
function se(t, e) {
  const a = b.get(t);
  return a ? (b.delete(t), a(e)) : Promise.resolve();
}
export {
  R as a,
  te as b,
  ae as c,
  ne as h,
  Q as m,
  re as s,
  se as u
};
