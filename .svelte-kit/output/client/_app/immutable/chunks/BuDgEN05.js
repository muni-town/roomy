import { w as Q, k as W, x as D, q as C, y as Z, z as $, g as O, A as j, H as ee, B as q, C as M, v as H, D as ae, F as X, l as z, G as re, I as k, J as F, K as V, L as Y, M as ne, N as B, O as fe, P as b, Q as ie, R as le, S as se, o as ue, T as y, U as te, V as ve, W as de, X as G, Y as _e } from "./BMAj9zKA.js";
function pe(l, e) {
  return e;
}
function oe(l, e, a, u) {
  for (var v = [], _ = e.length, t = 0; t < _; t++) ie(e[t].e, v, true);
  var o = _ > 0 && v.length === 0 && a !== null;
  if (o) {
    var A = a.parentNode;
    le(A), A.append(a), u.clear(), m(l, e[0].prev, e[_ - 1].next);
  }
  se(v, () => {
    for (var h = 0; h < _; h++) {
      var d = e[h];
      o || (u.delete(d.k), m(l, d.prev, d.next)), ue(d.e, !o);
    }
  });
}
function Ae(l, e, a, u, v, _ = null) {
  var t = l, o = { flags: e, items: /* @__PURE__ */ new Map(), first: null }, A = (e & G) !== 0;
  if (A) {
    var h = l;
    t = C ? D(Z(h)) : h.appendChild(Q());
  }
  C && $();
  var d = null, w = false, f = j(() => {
    var s = a();
    return fe(s) ? s : s == null ? [] : F(s);
  });
  W(() => {
    var s = O(f), r = s.length;
    if (w && r === 0) return;
    w = r === 0;
    let I = false;
    if (C) {
      var E = t.data === ee;
      E !== (r === 0) && (t = q(), D(t), M(false), I = true);
    }
    if (C) {
      for (var p = null, T, c = 0; c < r; c++) {
        if (H.nodeType === 8 && H.data === ae) {
          t = H, I = true, M(false);
          break;
        }
        var n = s[c], i = u(n, c);
        T = J(H, o, p, null, n, i, c, v, e, a), o.items.set(i, T), p = T;
      }
      r > 0 && D(q());
    }
    C || ce(s, o, t, v, e, u, a), _ !== null && (r === 0 ? d ? X(d) : d = z(() => _(t)) : d !== null && re(d, () => {
      d = null;
    })), I && M(true), O(f);
  }), C && (t = H);
}
function ce(l, e, a, u, v, _, t) {
  var o = (v & _e) !== 0, A = (v & (y | b)) !== 0, h = l.length, d = e.items, w = e.first, f = w, s, r = null, I, E = [], p = [], T, c, n, i;
  if (o) for (i = 0; i < h; i += 1) T = l[i], c = _(T, i), n = d.get(c), n !== void 0 && (n.a?.measure(), (I ??= /* @__PURE__ */ new Set()).add(n));
  for (i = 0; i < h; i += 1) {
    if (T = l[i], c = _(T, i), n = d.get(c), n === void 0) {
      var K = f ? f.e.nodes_start : a;
      r = J(K, e, r, r === null ? e.first : r.next, T, c, i, u, v, t), d.set(c, r), E = [], p = [], f = r.next;
      continue;
    }
    if (A && he(n, T, i, v), (n.e.f & k) !== 0 && (X(n.e), o && (n.a?.unfix(), (I ??= /* @__PURE__ */ new Set()).delete(n))), n !== f) {
      if (s !== void 0 && s.has(n)) {
        if (E.length < p.length) {
          var R = p[0], x;
          r = R.prev;
          var L = E[0], S = E[E.length - 1];
          for (x = 0; x < E.length; x += 1) U(E[x], R, a);
          for (x = 0; x < p.length; x += 1) s.delete(p[x]);
          m(e, L.prev, S.next), m(e, r, L), m(e, S, R), f = R, r = S, i -= 1, E = [], p = [];
        } else s.delete(n), U(n, f, a), m(e, n.prev, n.next), m(e, n, r === null ? e.first : r.next), m(e, r, n), r = n;
        continue;
      }
      for (E = [], p = []; f !== null && f.k !== c; ) (f.e.f & k) === 0 && (s ??= /* @__PURE__ */ new Set()).add(f), p.push(f), f = f.next;
      if (f === null) continue;
      n = f;
    }
    E.push(n), r = n, f = n.next;
  }
  if (f !== null || s !== void 0) {
    for (var N = s === void 0 ? [] : F(s); f !== null; ) (f.e.f & k) === 0 && N.push(f), f = f.next;
    var g = N.length;
    if (g > 0) {
      var P = (v & G) !== 0 && h === 0 ? a : null;
      if (o) {
        for (i = 0; i < g; i += 1) N[i].a?.measure();
        for (i = 0; i < g; i += 1) N[i].a?.fix();
      }
      oe(e, N, P, d);
    }
  }
  o && de(() => {
    if (I !== void 0) for (n of I) n.a?.apply();
  }), V.first = e.first && e.first.e, V.last = r && r.e;
}
function he(l, e, a, u) {
  (u & y) !== 0 && Y(l.v, e), (u & b) !== 0 ? Y(l.i, a) : l.i = a;
}
function J(l, e, a, u, v, _, t, o, A, h) {
  var d = (A & y) !== 0, w = (A & te) === 0, f = d ? w ? ne(v) : B(v) : v, s = (A & b) === 0 ? t : B(t), r = { i: s, v: f, k: _, a: null, e: null, prev: a, next: u };
  try {
    return r.e = z(() => o(l, f, s, h), C), r.e.prev = a && a.e, r.e.next = u && u.e, a === null ? e.first = r : (a.next = r, a.e.next = r.e), u !== null && (u.prev = r, u.e.prev = r.e), r;
  } finally {
  }
}
function U(l, e, a) {
  for (var u = l.next ? l.next.e.nodes_start : a, v = e ? e.e.nodes_start : a, _ = l.e.nodes_start; _ !== u; ) {
    var t = ve(_);
    v.before(_), _ = t;
  }
}
function m(l, e, a) {
  e === null ? l.first = a : (e.next = a, e.e.next = a && a.e), a !== null && (a.prev = e, a.e.prev = e && e.e);
}
export {
  Ae as e,
  pe as i
};
