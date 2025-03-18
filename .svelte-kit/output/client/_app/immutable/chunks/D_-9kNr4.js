import { ak as $, al as j, m as g, M as T, b as q, g as l, aa as S, am as C, an as G, e as A, A as z, ao as K, ap as V, a0 as D, N as Z, aq as F, a6 as M, ar as U, as as H, at as J, au as L, av as Q, aw as _ } from "./BMAj9zKA.js";
import { p as W } from "./Baj-A2iI.js";
import { s as X, g as k } from "./Dxu-ImQV.js";
import { l as ee } from "./DIeogL5L.js";
let v = false, I = Symbol();
function oe(e, r, s) {
  const n = s[r] ??= { store: null, source: T(void 0), unsubscribe: g };
  if (n.store !== e && !(I in s)) if (n.unsubscribe(), n.store = e ?? null, e == null) n.source.v = void 0, n.unsubscribe = g;
  else {
    var i = true;
    n.unsubscribe = X(e, (t) => {
      i ? n.source.v = t : q(n.source, t);
    }), i = false;
  }
  return e && I in s ? k(e) : l(n.source);
}
function ce(e, r) {
  return e.set(r), r;
}
function pe() {
  const e = {};
  function r() {
    $(() => {
      for (var s in e) e[s].unsubscribe();
      j(e, I, { enumerable: false, value: true });
    });
  }
  return [e, r];
}
function de() {
  v = true;
}
function re(e) {
  var r = v;
  try {
    return v = false, [e(), v];
  } finally {
    v = r;
  }
}
const ne = { get(e, r) {
  if (!e.exclude.includes(r)) return e.props[r];
}, set(e, r) {
  return false;
}, getOwnPropertyDescriptor(e, r) {
  if (!e.exclude.includes(r) && r in e.props) return { enumerable: true, configurable: true, value: e.props[r] };
}, has(e, r) {
  return e.exclude.includes(r) ? false : r in e.props;
}, ownKeys(e) {
  return Reflect.ownKeys(e.props).filter((r) => !e.exclude.includes(r));
} };
function _e(e, r, s) {
  return new Proxy({ props: e, exclude: r }, ne);
}
const se = { get(e, r) {
  if (!e.exclude.includes(r)) return l(e.version), r in e.special ? e.special[r]() : e.props[r];
}, set(e, r, s) {
  return r in e.special || (e.special[r] = ie({ get [r]() {
    return e.props[r];
  } }, r, K)), e.special[r](s), L(e.version), true;
}, getOwnPropertyDescriptor(e, r) {
  if (!e.exclude.includes(r) && r in e.props) return { enumerable: true, configurable: true, value: e.props[r] };
}, deleteProperty(e, r) {
  return e.exclude.includes(r) || (e.exclude.push(r), L(e.version)), true;
}, has(e, r) {
  return e.exclude.includes(r) ? false : r in e.props;
}, ownKeys(e) {
  return Reflect.ownKeys(e.props).filter((r) => !e.exclude.includes(r));
} };
function ve(e, r) {
  return new Proxy({ props: e, exclude: r, special: {}, version: Z(0) }, se);
}
const ue = { get(e, r) {
  let s = e.props.length;
  for (; s--; ) {
    let n = e.props[s];
    if (_(n) && (n = n()), typeof n == "object" && n !== null && r in n) return n[r];
  }
}, set(e, r, s) {
  let n = e.props.length;
  for (; n--; ) {
    let i = e.props[n];
    _(i) && (i = i());
    const t = S(i, r);
    if (t && t.set) return t.set(s), true;
  }
  return false;
}, getOwnPropertyDescriptor(e, r) {
  let s = e.props.length;
  for (; s--; ) {
    let n = e.props[s];
    if (_(n) && (n = n()), typeof n == "object" && n !== null && r in n) {
      const i = S(n, r);
      return i && !i.configurable && (i.configurable = true), i;
    }
  }
}, has(e, r) {
  if (r === M || r === U) return false;
  for (let s of e.props) if (_(s) && (s = s()), s != null && r in s) return true;
  return false;
}, ownKeys(e) {
  const r = [];
  for (let s of e.props) {
    _(s) && (s = s());
    for (const n in s) r.includes(n) || r.push(n);
  }
  return r;
} };
function be(...e) {
  return new Proxy({ props: e }, ue);
}
function N(e) {
  return e.ctx?.d ?? false;
}
function ie(e, r, s, n) {
  var i = (s & J) !== 0, t = !ee || (s & H) !== 0, b = (s & F) !== 0, y = (s & Q) !== 0, O = false, o;
  b ? [o, O] = re(() => e[r]) : o = e[r];
  var B = M in e || U in e, d = b && (S(e, r)?.set ?? (B && r in e && ((u) => e[r] = u))) || void 0, f = n, m = true, P = false, R = () => (P = true, m && (m = false, y ? f = D(n) : f = n), f);
  o === void 0 && n !== void 0 && (d && t && C(), o = R(), d && d(o));
  var c;
  if (t) c = () => {
    var u = e[r];
    return u === void 0 ? R() : (m = true, P = false, u);
  };
  else {
    var E = (i ? A : z)(() => e[r]);
    E.f |= G, c = () => {
      var u = l(E);
      return u !== void 0 && (f = void 0), u === void 0 ? f : u;
    };
  }
  if ((s & K) === 0) return c;
  if (d) {
    var Y = e.$$legacy;
    return function(u, p) {
      return arguments.length > 0 ? ((!t || !p || Y || O) && d(p ? c() : u), u) : c();
    };
  }
  var h = false, w = T(o), a = A(() => {
    var u = c(), p = l(w);
    return h ? (h = false, p) : w.v = u;
  });
  return b && l(a), i || (a.equals = V), function(u, p) {
    if (arguments.length > 0) {
      const x = p ? l(a) : t && b ? W(u) : u;
      if (!a.equals(x)) {
        if (h = true, q(w, x), P && f !== void 0 && (f = x), N(a)) return u;
        D(() => l(a));
      }
      return u;
    }
    return N(a) ? a.v : l(a);
  };
}
export {
  pe as a,
  oe as b,
  ce as c,
  ve as l,
  de as m,
  ie as p,
  _e as r,
  be as s
};
