import "./NZTpNUN0.js";
import "./69_IOA4Y.js";
import { k as Pe, q as Y, z as J, l as je, v as X, V as Ee, ah as Oe, ag as Fe, x as Le, y as O, o as Ae, p as Me, aB as De, aC as Re, f as Z, a as Ne, b as ee, aD as F, aE as z, g as b, a2 as $e, au as ze, c as qe, r as Qe, t as te } from "./BMAj9zKA.js";
import { b as ne, d as Ue, c as oe, a as L, n as He, t as Ve } from "./pDBoOQRd.js";
import { i as se } from "./BA1UOs1h.js";
import { b as re } from "./DjDC-EQm.js";
import { i as Be } from "./CrW2qrX9.js";
import { l as Ge } from "./D_-9kNr4.js";
import { o as Ke, a as We, c as Ye } from "./BqahWDdA.js";
function Je(e, n, o, s, t) {
  var r = e, i = "", c;
  Pe(() => {
    if (i === (i = n() ?? "")) {
      Y && J();
      return;
    }
    c !== void 0 && (Ae(c), c = void 0), i !== "" && (c = je(() => {
      if (Y) {
        X.data;
        for (var l = J(), a = l; l !== null && (l.nodeType !== 8 || l.data !== ""); ) a = l, l = Ee(l);
        if (l === null) throw Oe(), Fe;
        ne(X, a), r = Le(l);
        return;
      }
      var f = i + "";
      o && (f = `<svg>${f}</svg>`);
      var d = Ue(f);
      if ((o || s) && (d = O(d)), ne(O(d), d.lastChild), o || s) for (; O(d); ) r.before(O(d));
      else r.before(d);
    }));
  });
}
const ye = /^[a-z0-9]+(-[a-z0-9]+)*$/, R = (e, n, o, s = "") => {
  const t = e.split(":");
  if (e.slice(0, 1) === "@") {
    if (t.length < 2 || t.length > 3) return null;
    s = t.shift().slice(1);
  }
  if (t.length > 3 || !t.length) return null;
  if (t.length > 1) {
    const c = t.pop(), l = t.pop(), a = { provider: t.length > 0 ? t[0] : s, prefix: l, name: c };
    return n && !A(a) ? null : a;
  }
  const r = t[0], i = r.split("-");
  if (i.length > 1) {
    const c = { provider: s, prefix: i.shift(), name: i.join("-") };
    return n && !A(c) ? null : c;
  }
  if (o && s === "") {
    const c = { provider: s, prefix: "", name: r };
    return n && !A(c, o) ? null : c;
  }
  return null;
}, A = (e, n) => e ? !!((n && e.prefix === "" || e.prefix) && e.name) : false, be = Object.freeze({ left: 0, top: 0, width: 16, height: 16 }), D = Object.freeze({ rotate: 0, vFlip: false, hFlip: false }), N = Object.freeze({ ...be, ...D }), U = Object.freeze({ ...N, body: "", hidden: false });
function Xe(e, n) {
  const o = {};
  !e.hFlip != !n.hFlip && (o.hFlip = true), !e.vFlip != !n.vFlip && (o.vFlip = true);
  const s = ((e.rotate || 0) + (n.rotate || 0)) % 4;
  return s && (o.rotate = s), o;
}
function ie(e, n) {
  const o = Xe(e, n);
  for (const s in U) s in D ? s in e && !(s in o) && (o[s] = D[s]) : s in n ? o[s] = n[s] : s in e && (o[s] = e[s]);
  return o;
}
function Ze(e, n) {
  const o = e.icons, s = e.aliases || /* @__PURE__ */ Object.create(null), t = /* @__PURE__ */ Object.create(null);
  function r(i) {
    if (o[i]) return t[i] = [];
    if (!(i in t)) {
      t[i] = null;
      const c = s[i] && s[i].parent, l = c && r(c);
      l && (t[i] = [c].concat(l));
    }
    return t[i];
  }
  return Object.keys(o).concat(Object.keys(s)).forEach(r), t;
}
function et(e, n, o) {
  const s = e.icons, t = e.aliases || /* @__PURE__ */ Object.create(null);
  let r = {};
  function i(c) {
    r = ie(s[c] || t[c], r);
  }
  return i(n), o.forEach(i), ie(e, r);
}
function ve(e, n) {
  const o = [];
  if (typeof e != "object" || typeof e.icons != "object") return o;
  e.not_found instanceof Array && e.not_found.forEach((t) => {
    n(t, null), o.push(t);
  });
  const s = Ze(e);
  for (const t in s) {
    const r = s[t];
    r && (n(t, et(e, t, r)), o.push(t));
  }
  return o;
}
const tt = { provider: "", aliases: {}, not_found: {}, ...be };
function q(e, n) {
  for (const o in n) if (o in e && typeof e[o] != typeof n[o]) return false;
  return true;
}
function xe(e) {
  if (typeof e != "object" || e === null) return null;
  const n = e;
  if (typeof n.prefix != "string" || !e.icons || typeof e.icons != "object" || !q(e, tt)) return null;
  const o = n.icons;
  for (const t in o) {
    const r = o[t];
    if (!t || typeof r.body != "string" || !q(r, U)) return null;
  }
  const s = n.aliases || /* @__PURE__ */ Object.create(null);
  for (const t in s) {
    const r = s[t], i = r.parent;
    if (!t || typeof i != "string" || !o[i] && !s[i] || !q(r, U)) return null;
  }
  return n;
}
const ce = /* @__PURE__ */ Object.create(null);
function nt(e, n) {
  return { provider: e, prefix: n, icons: /* @__PURE__ */ Object.create(null), missing: /* @__PURE__ */ new Set() };
}
function _(e, n) {
  const o = ce[e] || (ce[e] = /* @__PURE__ */ Object.create(null));
  return o[n] || (o[n] = nt(e, n));
}
function we(e, n) {
  return xe(n) ? ve(n, (o, s) => {
    s ? e.icons[o] = s : e.missing.add(o);
  }) : [];
}
function ot(e, n, o) {
  try {
    if (typeof o.body == "string") return e.icons[n] = { ...o }, true;
  } catch {
  }
  return false;
}
let j = false;
function Ie(e) {
  return typeof e == "boolean" && (j = e), j;
}
function st(e) {
  const n = typeof e == "string" ? R(e, true, j) : e;
  if (n) {
    const o = _(n.provider, n.prefix), s = n.name;
    return o.icons[s] || (o.missing.has(s) ? null : void 0);
  }
}
function rt(e, n) {
  const o = R(e, true, j);
  if (!o) return false;
  const s = _(o.provider, o.prefix);
  return n ? ot(s, o.name, n) : (s.missing.add(o.name), true);
}
function it(e, n) {
  if (typeof e != "object") return false;
  if (typeof n != "string" && (n = e.provider || ""), j && !n && !e.prefix) {
    let t = false;
    return xe(e) && (e.prefix = "", ve(e, (r, i) => {
      rt(r, i) && (t = true);
    })), t;
  }
  const o = e.prefix;
  if (!A({ prefix: o, name: "a" })) return false;
  const s = _(n, o);
  return !!we(s, e);
}
const ke = Object.freeze({ width: null, height: null }), Se = Object.freeze({ ...ke, ...D }), ct = /(-?[0-9.]*[0-9]+[0-9.]*)/g, lt = /^-?[0-9.]*[0-9]+[0-9.]*$/g;
function le(e, n, o) {
  if (n === 1) return e;
  if (o = o || 100, typeof e == "number") return Math.ceil(e * n * o) / o;
  if (typeof e != "string") return e;
  const s = e.split(ct);
  if (s === null || !s.length) return e;
  const t = [];
  let r = s.shift(), i = lt.test(r);
  for (; ; ) {
    if (i) {
      const c = parseFloat(r);
      isNaN(c) ? t.push(r) : t.push(Math.ceil(c * n * o) / o);
    } else t.push(r);
    if (r = s.shift(), r === void 0) return t.join("");
    i = !i;
  }
}
function at(e, n = "defs") {
  let o = "";
  const s = e.indexOf("<" + n);
  for (; s >= 0; ) {
    const t = e.indexOf(">", s), r = e.indexOf("</" + n);
    if (t === -1 || r === -1) break;
    const i = e.indexOf(">", r);
    if (i === -1) break;
    o += e.slice(t + 1, r).trim(), e = e.slice(0, s).trim() + e.slice(i + 1);
  }
  return { defs: o, content: e };
}
function ft(e, n) {
  return e ? "<defs>" + e + "</defs>" + n : n;
}
function ut(e, n, o) {
  const s = at(e);
  return ft(s.defs, n + s.content + o);
}
const dt = (e) => e === "unset" || e === "undefined" || e === "none";
function pt(e, n) {
  const o = { ...N, ...e }, s = { ...Se, ...n }, t = { left: o.left, top: o.top, width: o.width, height: o.height };
  let r = o.body;
  [o, s].forEach((I) => {
    const y = [], h = I.hFlip, u = I.vFlip;
    let v = I.rotate;
    h ? u ? v += 2 : (y.push("translate(" + (t.width + t.left).toString() + " " + (0 - t.top).toString() + ")"), y.push("scale(-1 1)"), t.top = t.left = 0) : u && (y.push("translate(" + (0 - t.left).toString() + " " + (t.height + t.top).toString() + ")"), y.push("scale(1 -1)"), t.top = t.left = 0);
    let w;
    switch (v < 0 && (v -= Math.floor(v / 4) * 4), v = v % 4, v) {
      case 1:
        w = t.height / 2 + t.top, y.unshift("rotate(90 " + w.toString() + " " + w.toString() + ")");
        break;
      case 2:
        y.unshift("rotate(180 " + (t.width / 2 + t.left).toString() + " " + (t.height / 2 + t.top).toString() + ")");
        break;
      case 3:
        w = t.width / 2 + t.left, y.unshift("rotate(-90 " + w.toString() + " " + w.toString() + ")");
        break;
    }
    v % 2 === 1 && (t.left !== t.top && (w = t.left, t.left = t.top, t.top = w), t.width !== t.height && (w = t.width, t.width = t.height, t.height = w)), y.length && (r = ut(r, '<g transform="' + y.join(" ") + '">', "</g>"));
  });
  const i = s.width, c = s.height, l = t.width, a = t.height;
  let f, d;
  i === null ? (d = c === null ? "1em" : c === "auto" ? a : c, f = le(d, l / a)) : (f = i === "auto" ? l : i, d = c === null ? le(f, a / l) : c === "auto" ? a : c);
  const p = {}, m = (I, y) => {
    dt(y) || (p[I] = y.toString());
  };
  m("width", f), m("height", d);
  const x = [t.left, t.top, l, a];
  return p.viewBox = x.join(" "), { attributes: p, viewBox: x, body: r };
}
const ht = /\sid="(\S+)"/g, gt = "IconifyId" + Date.now().toString(16) + (Math.random() * 16777216 | 0).toString(16);
let mt = 0;
function yt(e, n = gt) {
  const o = [];
  let s;
  for (; s = ht.exec(e); ) o.push(s[1]);
  if (!o.length) return e;
  const t = "suffix" + (Math.random() * 16777216 | Date.now()).toString(16);
  return o.forEach((r) => {
    const i = typeof n == "function" ? n(r) : n + (mt++).toString(), c = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    e = e.replace(new RegExp('([#;"])(' + c + ')([")]|\\.[a-z])', "g"), "$1" + i + t + "$3");
  }), e = e.replace(new RegExp(t, "g"), ""), e;
}
const H = /* @__PURE__ */ Object.create(null);
function bt(e, n) {
  H[e] = n;
}
function V(e) {
  return H[e] || H[""];
}
function G(e) {
  let n;
  if (typeof e.resources == "string") n = [e.resources];
  else if (n = e.resources, !(n instanceof Array) || !n.length) return null;
  return { resources: n, path: e.path || "/", maxURL: e.maxURL || 500, rotate: e.rotate || 750, timeout: e.timeout || 5e3, random: e.random === true, index: e.index || 0, dataAfterTimeout: e.dataAfterTimeout !== false };
}
const K = /* @__PURE__ */ Object.create(null), C = ["https://api.simplesvg.com", "https://api.unisvg.com"], M = [];
for (; C.length > 0; ) C.length === 1 || Math.random() > 0.5 ? M.push(C.shift()) : M.push(C.pop());
K[""] = G({ resources: ["https://api.iconify.design"].concat(M) });
function vt(e, n) {
  const o = G(n);
  return o === null ? false : (K[e] = o, true);
}
function W(e) {
  return K[e];
}
const xt = () => {
  let e;
  try {
    if (e = fetch, typeof e == "function") return e;
  } catch {
  }
};
let ae = xt();
function wt(e, n) {
  const o = W(e);
  if (!o) return 0;
  let s;
  if (!o.maxURL) s = 0;
  else {
    let t = 0;
    o.resources.forEach((i) => {
      t = Math.max(t, i.length);
    });
    const r = n + ".json?icons=";
    s = o.maxURL - t - o.path.length - r.length;
  }
  return s;
}
function It(e) {
  return e === 404;
}
const kt = (e, n, o) => {
  const s = [], t = wt(e, n), r = "icons";
  let i = { type: r, provider: e, prefix: n, icons: [] }, c = 0;
  return o.forEach((l, a) => {
    c += l.length + 1, c >= t && a > 0 && (s.push(i), i = { type: r, provider: e, prefix: n, icons: [] }, c = l.length), i.icons.push(l);
  }), s.push(i), s;
};
function St(e) {
  if (typeof e == "string") {
    const n = W(e);
    if (n) return n.path;
  }
  return "/";
}
const _t = (e, n, o) => {
  if (!ae) {
    o("abort", 424);
    return;
  }
  let s = St(n.provider);
  switch (n.type) {
    case "icons": {
      const r = n.prefix, c = n.icons.join(","), l = new URLSearchParams({ icons: c });
      s += r + ".json?" + l.toString();
      break;
    }
    case "custom": {
      const r = n.uri;
      s += r.slice(0, 1) === "/" ? r.slice(1) : r;
      break;
    }
    default:
      o("abort", 400);
      return;
  }
  let t = 503;
  ae(e + s).then((r) => {
    const i = r.status;
    if (i !== 200) {
      setTimeout(() => {
        o(It(i) ? "abort" : "next", i);
      });
      return;
    }
    return t = 501, r.json();
  }).then((r) => {
    if (typeof r != "object" || r === null) {
      setTimeout(() => {
        r === 404 ? o("abort", r) : o("next", t);
      });
      return;
    }
    setTimeout(() => {
      o("success", r);
    });
  }).catch(() => {
    o("next", t);
  });
}, Tt = { prepare: kt, send: _t };
function Ct(e) {
  const n = { loaded: [], missing: [], pending: [] }, o = /* @__PURE__ */ Object.create(null);
  e.sort((t, r) => t.provider !== r.provider ? t.provider.localeCompare(r.provider) : t.prefix !== r.prefix ? t.prefix.localeCompare(r.prefix) : t.name.localeCompare(r.name));
  let s = { provider: "", prefix: "", name: "" };
  return e.forEach((t) => {
    if (s.name === t.name && s.prefix === t.prefix && s.provider === t.provider) return;
    s = t;
    const r = t.provider, i = t.prefix, c = t.name, l = o[r] || (o[r] = /* @__PURE__ */ Object.create(null)), a = l[i] || (l[i] = _(r, i));
    let f;
    c in a.icons ? f = n.loaded : i === "" || a.missing.has(c) ? f = n.missing : f = n.pending;
    const d = { provider: r, prefix: i, name: c };
    f.push(d);
  }), n;
}
function _e(e, n) {
  e.forEach((o) => {
    const s = o.loaderCallbacks;
    s && (o.loaderCallbacks = s.filter((t) => t.id !== n));
  });
}
function Pt(e) {
  e.pendingCallbacksFlag || (e.pendingCallbacksFlag = true, setTimeout(() => {
    e.pendingCallbacksFlag = false;
    const n = e.loaderCallbacks ? e.loaderCallbacks.slice(0) : [];
    if (!n.length) return;
    let o = false;
    const s = e.provider, t = e.prefix;
    n.forEach((r) => {
      const i = r.icons, c = i.pending.length;
      i.pending = i.pending.filter((l) => {
        if (l.prefix !== t) return true;
        const a = l.name;
        if (e.icons[a]) i.loaded.push({ provider: s, prefix: t, name: a });
        else if (e.missing.has(a)) i.missing.push({ provider: s, prefix: t, name: a });
        else return o = true, true;
        return false;
      }), i.pending.length !== c && (o || _e([e], r.id), r.callback(i.loaded.slice(0), i.missing.slice(0), i.pending.slice(0), r.abort));
    });
  }));
}
let jt = 0;
function Et(e, n, o) {
  const s = jt++, t = _e.bind(null, o, s);
  if (!n.pending.length) return t;
  const r = { id: s, icons: n, callback: e, abort: t };
  return o.forEach((i) => {
    (i.loaderCallbacks || (i.loaderCallbacks = [])).push(r);
  }), t;
}
function Ot(e, n = true, o = false) {
  const s = [];
  return e.forEach((t) => {
    const r = typeof t == "string" ? R(t, n, o) : t;
    r && s.push(r);
  }), s;
}
var Ft = { resources: [], index: 0, timeout: 2e3, rotate: 750, random: false, dataAfterTimeout: false };
function Lt(e, n, o, s) {
  const t = e.resources.length, r = e.random ? Math.floor(Math.random() * t) : e.index;
  let i;
  if (e.random) {
    let g = e.resources.slice(0);
    for (i = []; g.length > 1; ) {
      const k = Math.floor(Math.random() * g.length);
      i.push(g[k]), g = g.slice(0, k).concat(g.slice(k + 1));
    }
    i = i.concat(g);
  } else i = e.resources.slice(r).concat(e.resources.slice(0, r));
  const c = Date.now();
  let l = "pending", a = 0, f, d = null, p = [], m = [];
  typeof s == "function" && m.push(s);
  function x() {
    d && (clearTimeout(d), d = null);
  }
  function I() {
    l === "pending" && (l = "aborted"), x(), p.forEach((g) => {
      g.status === "pending" && (g.status = "aborted");
    }), p = [];
  }
  function y(g, k) {
    k && (m = []), typeof g == "function" && m.push(g);
  }
  function h() {
    return { startTime: c, payload: n, status: l, queriesSent: a, queriesPending: p.length, subscribe: y, abort: I };
  }
  function u() {
    l = "failed", m.forEach((g) => {
      g(void 0, f);
    });
  }
  function v() {
    p.forEach((g) => {
      g.status === "pending" && (g.status = "aborted");
    }), p = [];
  }
  function w(g, k, T) {
    const E = k !== "success";
    switch (p = p.filter((S) => S !== g), l) {
      case "pending":
        break;
      case "failed":
        if (E || !e.dataAfterTimeout) return;
        break;
      default:
        return;
    }
    if (k === "abort") {
      f = T, u();
      return;
    }
    if (E) {
      f = T, p.length || (i.length ? $() : u());
      return;
    }
    if (x(), v(), !e.random) {
      const S = e.resources.indexOf(g.resource);
      S !== -1 && S !== e.index && (e.index = S);
    }
    l = "completed", m.forEach((S) => {
      S(T);
    });
  }
  function $() {
    if (l !== "pending") return;
    x();
    const g = i.shift();
    if (g === void 0) {
      if (p.length) {
        d = setTimeout(() => {
          x(), l === "pending" && (v(), u());
        }, e.timeout);
        return;
      }
      u();
      return;
    }
    const k = { status: "pending", resource: g, callback: (T, E) => {
      w(k, T, E);
    } };
    p.push(k), a++, d = setTimeout($, e.rotate), o(g, n, k.callback);
  }
  return setTimeout($), h;
}
function Te(e) {
  const n = { ...Ft, ...e };
  let o = [];
  function s() {
    o = o.filter((c) => c().status === "pending");
  }
  function t(c, l, a) {
    const f = Lt(n, c, l, (d, p) => {
      s(), a && a(d, p);
    });
    return o.push(f), f;
  }
  function r(c) {
    return o.find((l) => c(l)) || null;
  }
  return { query: t, find: r, setIndex: (c) => {
    n.index = c;
  }, getIndex: () => n.index, cleanup: s };
}
function fe() {
}
const Q = /* @__PURE__ */ Object.create(null);
function At(e) {
  if (!Q[e]) {
    const n = W(e);
    if (!n) return;
    const o = Te(n), s = { config: n, redundancy: o };
    Q[e] = s;
  }
  return Q[e];
}
function Mt(e, n, o) {
  let s, t;
  if (typeof e == "string") {
    const r = V(e);
    if (!r) return o(void 0, 424), fe;
    t = r.send;
    const i = At(e);
    i && (s = i.redundancy);
  } else {
    const r = G(e);
    if (r) {
      s = Te(r);
      const i = e.resources ? e.resources[0] : "", c = V(i);
      c && (t = c.send);
    }
  }
  return !s || !t ? (o(void 0, 424), fe) : s.query(n, t, o)().abort;
}
function ue() {
}
function Dt(e) {
  e.iconsLoaderFlag || (e.iconsLoaderFlag = true, setTimeout(() => {
    e.iconsLoaderFlag = false, Pt(e);
  }));
}
function Rt(e) {
  const n = [], o = [];
  return e.forEach((s) => {
    (s.match(ye) ? n : o).push(s);
  }), { valid: n, invalid: o };
}
function P(e, n, o) {
  function s() {
    const t = e.pendingIcons;
    n.forEach((r) => {
      t && t.delete(r), e.icons[r] || e.missing.add(r);
    });
  }
  if (o && typeof o == "object") try {
    if (!we(e, o).length) {
      s();
      return;
    }
  } catch (t) {
    console.error(t);
  }
  s(), Dt(e);
}
function de(e, n) {
  e instanceof Promise ? e.then((o) => {
    n(o);
  }).catch(() => {
    n(null);
  }) : n(e);
}
function Nt(e, n) {
  e.iconsToLoad ? e.iconsToLoad = e.iconsToLoad.concat(n).sort() : e.iconsToLoad = n, e.iconsQueueFlag || (e.iconsQueueFlag = true, setTimeout(() => {
    e.iconsQueueFlag = false;
    const { provider: o, prefix: s } = e, t = e.iconsToLoad;
    if (delete e.iconsToLoad, !t || !t.length) return;
    const r = e.loadIcon;
    if (e.loadIcons && (t.length > 1 || !r)) {
      de(e.loadIcons(t, s, o), (f) => {
        P(e, t, f);
      });
      return;
    }
    if (r) {
      t.forEach((f) => {
        const d = r(f, s, o);
        de(d, (p) => {
          const m = p ? { prefix: s, icons: { [f]: p } } : null;
          P(e, [f], m);
        });
      });
      return;
    }
    const { valid: i, invalid: c } = Rt(t);
    if (c.length && P(e, c, null), !i.length) return;
    const l = s.match(ye) ? V(o) : null;
    if (!l) {
      P(e, i, null);
      return;
    }
    l.prepare(o, s, i).forEach((f) => {
      Mt(o, f, (d) => {
        P(e, f.icons, d);
      });
    });
  }));
}
const $t = (e, n) => {
  const o = Ot(e, true, Ie()), s = Ct(o);
  if (!s.pending.length) {
    let l = true;
    return n && setTimeout(() => {
      l && n(s.loaded, s.missing, s.pending, ue);
    }), () => {
      l = false;
    };
  }
  const t = /* @__PURE__ */ Object.create(null), r = [];
  let i, c;
  return s.pending.forEach((l) => {
    const { provider: a, prefix: f } = l;
    if (f === c && a === i) return;
    i = a, c = f, r.push(_(a, f));
    const d = t[a] || (t[a] = /* @__PURE__ */ Object.create(null));
    d[f] || (d[f] = []);
  }), s.pending.forEach((l) => {
    const { provider: a, prefix: f, name: d } = l, p = _(a, f), m = p.pendingIcons || (p.pendingIcons = /* @__PURE__ */ new Set());
    m.has(d) || (m.add(d), t[a][f].push(d));
  }), r.forEach((l) => {
    const a = t[l.provider][l.prefix];
    a.length && Nt(l, a);
  }), n ? Et(n, s, r) : ue;
};
function zt(e, n) {
  const o = { ...e };
  for (const s in n) {
    const t = n[s], r = typeof t;
    s in ke ? (t === null || t && (r === "string" || r === "number")) && (o[s] = t) : r === typeof o[s] && (o[s] = s === "rotate" ? t % 4 : t);
  }
  return o;
}
const qt = /[\s,]+/;
function Qt(e, n) {
  n.split(qt).forEach((o) => {
    switch (o.trim()) {
      case "horizontal":
        e.hFlip = true;
        break;
      case "vertical":
        e.vFlip = true;
        break;
    }
  });
}
function Ut(e, n = 0) {
  const o = e.replace(/^-?[0-9.]*/, "");
  function s(t) {
    for (; t < 0; ) t += 4;
    return t % 4;
  }
  if (o === "") {
    const t = parseInt(e);
    return isNaN(t) ? 0 : s(t);
  } else if (o !== e) {
    let t = 0;
    switch (o) {
      case "%":
        t = 25;
        break;
      case "deg":
        t = 90;
    }
    if (t) {
      let r = parseFloat(e.slice(0, e.length - o.length));
      return isNaN(r) ? 0 : (r = r / t, r % 1 === 0 ? s(r) : 0);
    }
  }
  return n;
}
function Ht(e, n) {
  let o = e.indexOf("xlink:") === -1 ? "" : ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  for (const s in n) o += " " + s + '="' + n[s] + '"';
  return '<svg xmlns="http://www.w3.org/2000/svg"' + o + ">" + e + "</svg>";
}
function Vt(e) {
  return e.replace(/"/g, "'").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s+/g, " ");
}
function Bt(e) {
  return "data:image/svg+xml," + Vt(e);
}
function Gt(e) {
  return 'url("' + Bt(e) + '")';
}
const pe = { ...Se, inline: false }, Kt = { xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink", "aria-hidden": true, role: "img" }, Wt = { display: "inline-block" }, B = { "background-color": "currentColor" }, Ce = { "background-color": "transparent" }, he = { image: "var(--svg)", repeat: "no-repeat", size: "100% 100%" }, ge = { "-webkit-mask": B, mask: B, background: Ce };
for (const e in ge) {
  const n = ge[e];
  for (const o in he) n[e + "-" + o] = he[o];
}
function Yt(e) {
  return e + (e.match(/^[-0-9.]+$/) ? "px" : "");
}
function Jt(e, n) {
  const o = zt(pe, n), s = n.mode || "svg", t = s === "svg" ? { ...Kt } : {};
  e.body.indexOf("xlink:") === -1 && delete t["xmlns:xlink"];
  let r = typeof n.style == "string" ? n.style : "";
  for (let h in n) {
    const u = n[h];
    if (u !== void 0) switch (h) {
      case "icon":
      case "style":
      case "onLoad":
      case "mode":
      case "ssr":
        break;
      case "inline":
      case "hFlip":
      case "vFlip":
        o[h] = u === true || u === "true" || u === 1;
        break;
      case "flip":
        typeof u == "string" && Qt(o, u);
        break;
      case "color":
        r = r + (r.length > 0 && r.trim().slice(-1) !== ";" ? ";" : "") + "color: " + u + "; ";
        break;
      case "rotate":
        typeof u == "string" ? o[h] = Ut(u) : typeof u == "number" && (o[h] = u);
        break;
      case "ariaHidden":
      case "aria-hidden":
        u !== true && u !== "true" && delete t["aria-hidden"];
        break;
      default:
        if (h.slice(0, 3) === "on:") break;
        pe[h] === void 0 && (t[h] = u);
    }
  }
  const i = pt(e, o), c = i.attributes;
  if (o.inline && (r = "vertical-align: -0.125em; " + r), s === "svg") {
    Object.assign(t, c), r !== "" && (t.style = r);
    let h = 0, u = n.id;
    return typeof u == "string" && (u = u.replace(/-/g, "_")), { svg: true, attributes: t, body: yt(i.body, u ? () => u + "ID" + h++ : "iconifySvelte") };
  }
  const { body: l, width: a, height: f } = e, d = s === "mask" || (s === "bg" ? false : l.indexOf("currentColor") !== -1), p = Ht(l, { ...c, width: a + "", height: f + "" }), x = { "--svg": Gt(p) }, I = (h) => {
    const u = c[h];
    u && (x[h] = Yt(u));
  };
  I("width"), I("height"), Object.assign(x, Wt, d ? B : Ce);
  let y = "";
  for (const h in x) y += h + ": " + x[h] + ";";
  return t.style = y + r, { svg: false, attributes: t };
}
Ie(true);
bt("", Tt);
if (typeof document < "u" && typeof window < "u") {
  const e = window;
  if (e.IconifyPreload !== void 0) {
    const n = e.IconifyPreload, o = "Invalid IconifyPreload syntax.";
    typeof n == "object" && n !== null && (n instanceof Array ? n : [n]).forEach((s) => {
      try {
        (typeof s != "object" || s === null || s instanceof Array || typeof s.icons != "object" || typeof s.prefix != "string" || !it(s)) && console.error(o);
      } catch {
        console.error(o);
      }
    });
  }
  if (e.IconifyProviders !== void 0) {
    const n = e.IconifyProviders;
    if (typeof n == "object" && n !== null) for (let o in n) {
      const s = "IconifyProviders[" + o + "] is invalid.";
      try {
        const t = n[o];
        if (typeof t != "object" || !t || t.resources === void 0) continue;
        vt(o, t) || console.error(s);
      } catch {
        console.error(s);
      }
    }
  }
}
function Xt(e, n, o, s, t) {
  function r() {
    n.loading && (n.loading.abort(), n.loading = null);
  }
  if (typeof e == "object" && e !== null && typeof e.body == "string") return n.name = "", r(), { data: { ...N, ...e } };
  let i;
  if (typeof e != "string" || (i = R(e, false, true)) === null) return r(), null;
  const c = st(i);
  if (!c) return o && (!n.loading || n.loading.name !== e) && (r(), n.name = "", n.loading = { name: e, abort: $t([i], s) }), null;
  r(), n.name !== e && (n.name = e, t && !n.destroyed && t(e));
  const l = ["iconify"];
  return i.prefix !== "" && l.push("iconify--" + i.prefix), i.provider !== "" && l.push("iconify--" + i.provider), { data: c, classes: l };
}
function me(e, n) {
  return e ? Jt({ ...N, ...e }, n) : null;
}
var Zt = He("<svg><!></svg>"), en = Ve("<span></span>");
function un(e, n) {
  const o = Ge(n, ["children", "$$slots", "$$events", "$$legacy"]);
  Me(n, false);
  const s = F({ name: "", loading: null, destroyed: false });
  let t = F(false), r = F(0), i = F();
  const c = (p) => {
    typeof o.onLoad == "function" && o.onLoad(p), Ye()("load", { icon: p });
  };
  function l() {
    ze(r);
  }
  Ke(() => {
    ee(t, true);
  }), We(() => {
    z(s, b(s).destroyed = true), b(s).loading && (b(s).loading.abort(), z(s, b(s).loading = null));
  }), De(() => (b(r), $e(o), b(t), b(s), b(i), me), () => {
    b(r);
    const p = !!o.ssr || b(t), m = Xt(o.icon, b(s), p, l, c);
    ee(i, m ? me(m.data, o) : null), b(i) && m.classes && z(i, b(i).attributes.class = (typeof o.class == "string" ? o.class + " " : "") + m.classes.join(" "));
  }), Re(), Be();
  var a = oe(), f = Z(a);
  {
    var d = (p) => {
      var m = oe(), x = Z(m);
      {
        var I = (h) => {
          var u = Zt();
          let v;
          var w = qe(u);
          Je(w, () => b(i).body, true, false), Qe(u), te(() => v = re(u, v, { ...b(i).attributes })), L(h, u);
        }, y = (h) => {
          var u = en();
          let v;
          te(() => v = re(u, v, { ...b(i).attributes })), L(h, u);
        };
        se(x, (h) => {
          b(i).svg ? h(I) : h(y, false);
        });
      }
      L(p, m);
    };
    se(f, (p) => {
      b(i) && p(d);
    });
  }
  L(e, a), Ne();
}
export {
  un as I,
  Je as h
};
