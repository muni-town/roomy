import { o as ye } from "./BqahWDdA.js";
import { w as Se } from "./Dxu-ImQV.js";
import { d as T, g as x, b as P, aN as gt } from "./BMAj9zKA.js";
new URL("sveltekit-internal://");
function mt(e, t) {
  return e === "/" || t === "ignore" ? e : t === "never" ? e.endsWith("/") ? e.slice(0, -1) : e : t === "always" && !e.endsWith("/") ? e + "/" : e;
}
function _t(e) {
  return e.split("%25").map(decodeURI).join("%25");
}
function wt(e) {
  for (const t in e) e[t] = decodeURIComponent(e[t]);
  return e;
}
function ge({ href: e }) {
  return e.split("#")[0];
}
function yt(e, t, n, r = false) {
  const a = new URL(e);
  Object.defineProperty(a, "searchParams", { value: new Proxy(a.searchParams, { get(i, o) {
    if (o === "get" || o === "getAll" || o === "has") return (f) => (n(f), i[o](f));
    t();
    const c = Reflect.get(i, o);
    return typeof c == "function" ? c.bind(i) : c;
  } }), enumerable: true, configurable: true });
  const s = ["href", "pathname", "search", "toString", "toJSON"];
  r && s.push("hash");
  for (const i of s) Object.defineProperty(a, i, { get() {
    return t(), e[i];
  }, enumerable: true, configurable: true });
  return a;
}
function vt(...e) {
  let t = 5381;
  for (const n of e) if (typeof n == "string") {
    let r = n.length;
    for (; r; ) t = t * 33 ^ n.charCodeAt(--r);
  } else if (ArrayBuffer.isView(n)) {
    const r = new Uint8Array(n.buffer, n.byteOffset, n.byteLength);
    let a = r.length;
    for (; a; ) t = t * 33 ^ r[--a];
  } else throw new TypeError("value must be a string or TypedArray");
  return (t >>> 0).toString(36);
}
function bt(e) {
  const t = atob(e), n = new Uint8Array(t.length);
  for (let r = 0; r < t.length; r++) n[r] = t.charCodeAt(r);
  return n.buffer;
}
const At = window.fetch;
window.fetch = (e, t) => ((e instanceof Request ? e.method : t?.method || "GET") !== "GET" && G.delete(ke(e)), At(e, t));
const G = /* @__PURE__ */ new Map();
function St(e, t) {
  const n = ke(e, t), r = document.querySelector(n);
  if (r?.textContent) {
    let { body: a, ...s } = JSON.parse(r.textContent);
    const i = r.getAttribute("data-ttl");
    return i && G.set(n, { body: a, init: s, ttl: 1e3 * Number(i) }), r.getAttribute("data-b64") !== null && (a = bt(a)), Promise.resolve(new Response(a, s));
  }
  return window.fetch(e, t);
}
function kt(e, t, n) {
  if (G.size > 0) {
    const r = ke(e, n), a = G.get(r);
    if (a) {
      if (performance.now() < a.ttl && ["default", "force-cache", "only-if-cached", void 0].includes(n?.cache)) return new Response(a.body, a.init);
      G.delete(r);
    }
  }
  return window.fetch(t, n);
}
function ke(e, t) {
  let r = `script[data-sveltekit-fetched][data-url=${JSON.stringify(e instanceof Request ? e.url : e)}]`;
  if (t?.headers || t?.body) {
    const a = [];
    t.headers && a.push([...new Headers(t.headers)].join(",")), t.body && (typeof t.body == "string" || ArrayBuffer.isView(t.body)) && a.push(t.body), r += `[data-hash="${vt(...a)}"]`;
  }
  return r;
}
const Et = /^(\[)?(\.\.\.)?(\w+)(?:=(\w+))?(\])?$/;
function Rt(e) {
  const t = [];
  return { pattern: e === "/" ? /^\/$/ : new RegExp(`^${Ut(e).map((r) => {
    const a = /^\[\.\.\.(\w+)(?:=(\w+))?\]$/.exec(r);
    if (a) return t.push({ name: a[1], matcher: a[2], optional: false, rest: true, chained: true }), "(?:/(.*))?";
    const s = /^\[\[(\w+)(?:=(\w+))?\]\]$/.exec(r);
    if (s) return t.push({ name: s[1], matcher: s[2], optional: true, rest: false, chained: true }), "(?:/([^/]+))?";
    if (!r) return;
    const i = r.split(/\[(.+?)\](?!\])/);
    return "/" + i.map((c, f) => {
      if (f % 2) {
        if (c.startsWith("x+")) return me(String.fromCharCode(parseInt(c.slice(2), 16)));
        if (c.startsWith("u+")) return me(String.fromCharCode(...c.slice(2).split("-").map((_) => parseInt(_, 16))));
        const u = Et.exec(c), [, h, d, l, p] = u;
        return t.push({ name: l, matcher: p, optional: !!h, rest: !!d, chained: d ? f === 1 && i[0] === "" : false }), d ? "(.*?)" : h ? "([^/]*)?" : "([^/]+?)";
      }
      return me(c);
    }).join("");
  }).join("")}/?$`), params: t };
}
function It(e) {
  return !/^\([^)]+\)$/.test(e);
}
function Ut(e) {
  return e.slice(1).split("/").filter(It);
}
function Lt(e, t, n) {
  const r = {}, a = e.slice(1), s = a.filter((o) => o !== void 0);
  let i = 0;
  for (let o = 0; o < t.length; o += 1) {
    const c = t[o];
    let f = a[o - i];
    if (c.chained && c.rest && i && (f = a.slice(o - i, o + 1).filter((u) => u).join("/"), i = 0), f === void 0) {
      c.rest && (r[c.name] = "");
      continue;
    }
    if (!c.matcher || n[c.matcher](f)) {
      r[c.name] = f;
      const u = t[o + 1], h = a[o + 1];
      u && !u.rest && u.optional && h && c.chained && (i = 0), !u && !h && Object.keys(r).length === s.length && (i = 0);
      continue;
    }
    if (c.optional && c.chained) {
      i++;
      continue;
    }
    return;
  }
  if (!i) return r;
}
function me(e) {
  return e.normalize().replace(/[[\]]/g, "\\$&").replace(/%/g, "%25").replace(/\//g, "%2[Ff]").replace(/\?/g, "%3[Ff]").replace(/#/g, "%23").replace(/[.*+?^${}()|\\]/g, "\\$&");
}
function Tt({ nodes: e, server_loads: t, dictionary: n, matchers: r }) {
  const a = new Set(t);
  return Object.entries(n).map(([o, [c, f, u]]) => {
    const { pattern: h, params: d } = Rt(o), l = { id: o, exec: (p) => {
      const _ = h.exec(p);
      if (_) return Lt(_, d, r);
    }, errors: [1, ...u || []].map((p) => e[p]), layouts: [0, ...f || []].map(i), leaf: s(c) };
    return l.errors.length = l.layouts.length = Math.max(l.errors.length, l.layouts.length), l;
  });
  function s(o) {
    const c = o < 0;
    return c && (o = ~o), [c, e[o]];
  }
  function i(o) {
    return o === void 0 ? o : [a.has(o), e[o]];
  }
}
function He(e, t = JSON.parse) {
  try {
    return t(sessionStorage[e]);
  } catch {
  }
}
function je(e, t, n = JSON.stringify) {
  const r = n(t);
  try {
    sessionStorage[e] = r;
  } catch {
  }
}
const U = globalThis.__sveltekit_ltnoxd?.base ?? "", xt = globalThis.__sveltekit_ltnoxd?.assets ?? U, Pt = "1742335290192", Ke = "sveltekit:snapshot", We = "sveltekit:scroll", Ye = "sveltekit:states", Ct = "sveltekit:pageurl", V = "sveltekit:history", W = "sveltekit:navigation", j = { tap: 1, hover: 2, viewport: 3, eager: 4, off: -1, false: -1 }, X = location.origin;
function Je(e) {
  if (e instanceof URL) return e;
  let t = document.baseURI;
  if (!t) {
    const n = document.getElementsByTagName("base");
    t = n.length ? n[0].href : document.URL;
  }
  return new URL(e, t);
}
function Ee() {
  return { x: pageXOffset, y: pageYOffset };
}
function F(e, t) {
  return e.getAttribute(`data-sveltekit-${t}`);
}
const $e = { ...j, "": j.hover };
function ze(e) {
  let t = e.assignedSlot ?? e.parentNode;
  return t?.nodeType === 11 && (t = t.host), t;
}
function Xe(e, t) {
  for (; e && e !== t; ) {
    if (e.nodeName.toUpperCase() === "A" && e.hasAttribute("href")) return e;
    e = ze(e);
  }
}
function ve(e, t, n) {
  let r;
  try {
    if (r = new URL(e instanceof SVGAElement ? e.href.baseVal : e.href, document.baseURI), n && r.hash.match(/^#[^/]/)) {
      const o = location.hash.split("#")[1] || "/";
      r.hash = `#${o}${r.hash}`;
    }
  } catch {
  }
  const a = e instanceof SVGAElement ? e.target.baseVal : e.target, s = !r || !!a || le(r, t, n) || (e.getAttribute("rel") || "").split(/\s+/).includes("external"), i = r?.origin === X && e.hasAttribute("download");
  return { url: r, external: s, target: a, download: i };
}
function te(e) {
  let t = null, n = null, r = null, a = null, s = null, i = null, o = e;
  for (; o && o !== document.documentElement; ) r === null && (r = F(o, "preload-code")), a === null && (a = F(o, "preload-data")), t === null && (t = F(o, "keepfocus")), n === null && (n = F(o, "noscroll")), s === null && (s = F(o, "reload")), i === null && (i = F(o, "replacestate")), o = ze(o);
  function c(f) {
    switch (f) {
      case "":
      case "true":
        return true;
      case "off":
      case "false":
        return false;
      default:
        return;
    }
  }
  return { preload_code: $e[r ?? "off"], preload_data: $e[a ?? "off"], keepfocus: c(t), noscroll: c(n), reload: c(s), replace_state: c(i) };
}
function De(e) {
  const t = Se(e);
  let n = true;
  function r() {
    n = true, t.update((i) => i);
  }
  function a(i) {
    n = false, t.set(i);
  }
  function s(i) {
    let o;
    return t.subscribe((c) => {
      (o === void 0 || n && c !== o) && i(o = c);
    });
  }
  return { notify: r, set: a, subscribe: s };
}
const Ze = { v: () => {
} };
function Nt() {
  const { set: e, subscribe: t } = Se(false);
  let n;
  async function r() {
    clearTimeout(n);
    try {
      const a = await fetch(`${xt}/_app/version.json`, { headers: { pragma: "no-cache", "cache-control": "no-cache" } });
      if (!a.ok) return false;
      const i = (await a.json()).version !== Pt;
      return i && (e(true), Ze.v(), clearTimeout(n)), i;
    } catch {
      return false;
    }
  }
  return { subscribe: t, check: r };
}
function le(e, t, n) {
  return e.origin !== X || !e.pathname.startsWith(t) ? true : n ? !(e.pathname === t + "/" || e.pathname === t + "/index.html" || e.protocol === "file:" && e.pathname.replace(/\/[^/]+\.html?$/, "") === t) : false;
}
function vn(e) {
}
function Fe(e) {
  const t = jt(e), n = new ArrayBuffer(t.length), r = new DataView(n);
  for (let a = 0; a < n.byteLength; a++) r.setUint8(a, t.charCodeAt(a));
  return n;
}
const Ot = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function jt(e) {
  e.length % 4 === 0 && (e = e.replace(/==?$/, ""));
  let t = "", n = 0, r = 0;
  for (let a = 0; a < e.length; a++) n <<= 6, n |= Ot.indexOf(e[a]), r += 6, r === 24 && (t += String.fromCharCode((n & 16711680) >> 16), t += String.fromCharCode((n & 65280) >> 8), t += String.fromCharCode(n & 255), n = r = 0);
  return r === 12 ? (n >>= 4, t += String.fromCharCode(n)) : r === 18 && (n >>= 2, t += String.fromCharCode((n & 65280) >> 8), t += String.fromCharCode(n & 255)), t;
}
const $t = -1, Dt = -2, Ft = -3, Vt = -4, Bt = -5, Mt = -6;
function qt(e, t) {
  if (typeof e == "number") return a(e, true);
  if (!Array.isArray(e) || e.length === 0) throw new Error("Invalid input");
  const n = e, r = Array(n.length);
  function a(s, i = false) {
    if (s === $t) return;
    if (s === Ft) return NaN;
    if (s === Vt) return 1 / 0;
    if (s === Bt) return -1 / 0;
    if (s === Mt) return -0;
    if (i) throw new Error("Invalid input");
    if (s in r) return r[s];
    const o = n[s];
    if (!o || typeof o != "object") r[s] = o;
    else if (Array.isArray(o)) if (typeof o[0] == "string") {
      const c = o[0], f = t?.[c];
      if (f) return r[s] = f(a(o[1]));
      switch (c) {
        case "Date":
          r[s] = new Date(o[1]);
          break;
        case "Set":
          const u = /* @__PURE__ */ new Set();
          r[s] = u;
          for (let l = 1; l < o.length; l += 1) u.add(a(o[l]));
          break;
        case "Map":
          const h = /* @__PURE__ */ new Map();
          r[s] = h;
          for (let l = 1; l < o.length; l += 2) h.set(a(o[l]), a(o[l + 1]));
          break;
        case "RegExp":
          r[s] = new RegExp(o[1], o[2]);
          break;
        case "Object":
          r[s] = Object(o[1]);
          break;
        case "BigInt":
          r[s] = BigInt(o[1]);
          break;
        case "null":
          const d = /* @__PURE__ */ Object.create(null);
          r[s] = d;
          for (let l = 1; l < o.length; l += 2) d[o[l]] = a(o[l + 1]);
          break;
        case "Int8Array":
        case "Uint8Array":
        case "Uint8ClampedArray":
        case "Int16Array":
        case "Uint16Array":
        case "Int32Array":
        case "Uint32Array":
        case "Float32Array":
        case "Float64Array":
        case "BigInt64Array":
        case "BigUint64Array": {
          const l = globalThis[c], p = o[1], _ = Fe(p), m = new l(_);
          r[s] = m;
          break;
        }
        case "ArrayBuffer": {
          const l = o[1], p = Fe(l);
          r[s] = p;
          break;
        }
        default:
          throw new Error(`Unknown type ${c}`);
      }
    } else {
      const c = new Array(o.length);
      r[s] = c;
      for (let f = 0; f < o.length; f += 1) {
        const u = o[f];
        u !== Dt && (c[f] = a(u));
      }
    }
    else {
      const c = {};
      r[s] = c;
      for (const f in o) {
        const u = o[f];
        c[f] = a(u);
      }
    }
    return r[s];
  }
  return a(0);
}
const Qe = /* @__PURE__ */ new Set(["load", "prerender", "csr", "ssr", "trailingSlash", "config"]);
[...Qe];
const Gt = /* @__PURE__ */ new Set([...Qe]);
[...Gt];
function Ht(e) {
  return e.filter((t) => t != null);
}
class fe {
  constructor(t, n) {
    this.status = t, typeof n == "string" ? this.body = { message: n } : n ? this.body = n : this.body = { message: `Error: ${t}` };
  }
  toString() {
    return JSON.stringify(this.body);
  }
}
class Re {
  constructor(t, n) {
    this.status = t, this.location = n;
  }
}
class Ie extends Error {
  constructor(t, n, r) {
    super(r), this.status = t, this.text = n;
  }
}
const Kt = "x-sveltekit-invalidated", Wt = "x-sveltekit-trailing-slash";
function ne(e) {
  return e instanceof fe || e instanceof Ie ? e.status : 500;
}
function Yt(e) {
  return e instanceof Ie ? e.text : "Internal Error";
}
let k, Y, _e;
const Jt = ye.toString().includes("$$") || /function \w+\(\) \{\}/.test(ye.toString());
Jt ? (k = { data: {}, form: null, error: null, params: {}, route: { id: null }, state: {}, status: -1, url: new URL("https://example.com") }, Y = { current: null }, _e = { current: false }) : (k = new class {
  #e = T({});
  get data() {
    return x(this.#e);
  }
  set data(t) {
    P(this.#e, t);
  }
  #t = T(null);
  get form() {
    return x(this.#t);
  }
  set form(t) {
    P(this.#t, t);
  }
  #n = T(null);
  get error() {
    return x(this.#n);
  }
  set error(t) {
    P(this.#n, t);
  }
  #r = T({});
  get params() {
    return x(this.#r);
  }
  set params(t) {
    P(this.#r, t);
  }
  #a = T({ id: null });
  get route() {
    return x(this.#a);
  }
  set route(t) {
    P(this.#a, t);
  }
  #o = T({});
  get state() {
    return x(this.#o);
  }
  set state(t) {
    P(this.#o, t);
  }
  #s = T(-1);
  get status() {
    return x(this.#s);
  }
  set status(t) {
    P(this.#s, t);
  }
  #i = T(new URL("https://example.com"));
  get url() {
    return x(this.#i);
  }
  set url(t) {
    P(this.#i, t);
  }
}(), Y = new class {
  #e = T(null);
  get current() {
    return x(this.#e);
  }
  set current(t) {
    P(this.#e, t);
  }
}(), _e = new class {
  #e = T(false);
  get current() {
    return x(this.#e);
  }
  set current(t) {
    P(this.#e, t);
  }
}(), Ze.v = () => _e.current = true);
function zt(e) {
  Object.assign(k, e);
}
const Xt = "/__data.json", Zt = ".html__data.json";
function Qt(e) {
  return e.endsWith(".html") ? e.replace(/\.html$/, Zt) : e.replace(/\/$/, "") + Xt;
}
const en = /* @__PURE__ */ new Set(["icon", "shortcut icon", "apple-touch-icon"]), D = He(We) ?? {}, J = He(Ke) ?? {}, O = { url: De({}), page: De({}), navigating: Se(null), updated: Nt() };
function Ue(e) {
  D[e] = Ee();
}
function tn(e, t) {
  let n = e + 1;
  for (; D[n]; ) delete D[n], n += 1;
  for (n = t + 1; J[n]; ) delete J[n], n += 1;
}
function M(e) {
  return location.href = e.href, new Promise(() => {
  });
}
async function et() {
  if ("serviceWorker" in navigator) {
    const e = await navigator.serviceWorker.getRegistration(U || "/");
    e && await e.update();
  }
}
function Ve() {
}
let Le, be, re, C, Ae, v;
const ae = [], oe = [];
let N = null;
const Q = /* @__PURE__ */ new Map(), tt = /* @__PURE__ */ new Set(), nt = /* @__PURE__ */ new Set(), H = /* @__PURE__ */ new Set();
let y = { branch: [], error: null, url: null }, Te = false, se = false, Be = true, z = false, q = false, rt = false, xe = false, at, A, I, $;
const K = /* @__PURE__ */ new Set();
async function kn(e, t, n) {
  document.URL !== location.href && (location.href = location.href), v = e, await e.hooks.init?.(), Le = Tt(e), C = document.documentElement, Ae = t, be = e.nodes[0], re = e.nodes[1], be(), re(), A = history.state?.[V], I = history.state?.[W], A || (A = I = Date.now(), history.replaceState({ ...history.state, [V]: A, [W]: I }, ""));
  const r = D[A];
  r && (history.scrollRestoration = "manual", scrollTo(r.x, r.y)), n ? await pn(Ae, n) : await un(v.hash ? mn(new URL(location.href)) : location.href, { replaceState: true }), hn();
}
function nn() {
  ae.length = 0, xe = false;
}
function ot(e) {
  oe.some((t) => t?.snapshot) && (J[e] = oe.map((t) => t?.snapshot?.capture()));
}
function st(e) {
  J[e]?.forEach((t, n) => {
    oe[n]?.snapshot?.restore(t);
  });
}
function Me() {
  Ue(A), je(We, D), ot(I), je(Ke, J);
}
async function Pe(e, t, n, r) {
  return ee({ type: "goto", url: Je(e), keepfocus: t.keepFocus, noscroll: t.noScroll, replace_state: t.replaceState, state: t.state, redirect_count: n, nav_token: r, accept: () => {
    t.invalidateAll && (xe = true), t.invalidate && t.invalidate.forEach(dn);
  } });
}
async function rn(e) {
  if (e.id !== N?.id) {
    const t = {};
    K.add(t), N = { id: e.id, token: t, promise: lt({ ...e, preload: t }).then((n) => (K.delete(t), n.type === "loaded" && n.state.error && (N = null), n)) };
  }
  return N.promise;
}
async function we(e) {
  const t = (await de(e, false))?.route;
  t && await Promise.all([...t.layouts, t.leaf].map((n) => n?.[1]()));
}
function it(e, t, n) {
  y = e.state;
  const r = document.querySelector("style[data-sveltekit]");
  r && r.remove(), Object.assign(k, e.props.page), at = new v.root({ target: t, props: { ...e.props, stores: O, components: oe }, hydrate: n, sync: false }), st(I);
  const a = { from: null, to: { params: y.params, route: { id: y.route?.id ?? null }, url: new URL(location.href) }, willUnload: false, type: "enter", complete: Promise.resolve() };
  H.forEach((s) => s(a)), se = true;
}
function ie({ url: e, params: t, branch: n, status: r, error: a, route: s, form: i }) {
  let o = "never";
  if (U && (e.pathname === U || e.pathname === U + "/")) o = "always";
  else for (const l of n) l?.slash !== void 0 && (o = l.slash);
  e.pathname = mt(e.pathname, o), e.search = e.search;
  const c = { type: "loaded", state: { url: e, params: t, branch: n, error: a, route: s }, props: { constructors: Ht(n).map((l) => l.node.component), page: Oe(k) } };
  i !== void 0 && (c.props.form = i);
  let f = {}, u = !k, h = 0;
  for (let l = 0; l < Math.max(n.length, y.branch.length); l += 1) {
    const p = n[l], _ = y.branch[l];
    p?.data !== _?.data && (u = true), p && (f = { ...f, ...p.data }, u && (c.props[`data_${h}`] = f), h += 1);
  }
  return (!y.url || e.href !== y.url.href || y.error !== a || i !== void 0 && i !== k.form || u) && (c.props.page = { error: a, params: t, route: { id: s?.id ?? null }, state: {}, status: r, url: new URL(e), form: i ?? null, data: u ? f : k.data }), c;
}
async function Ce({ loader: e, parent: t, url: n, params: r, route: a, server_data_node: s }) {
  let i = null, o = true;
  const c = { dependencies: /* @__PURE__ */ new Set(), params: /* @__PURE__ */ new Set(), parent: false, route: false, url: false, search_params: /* @__PURE__ */ new Set() }, f = await e();
  if (f.universal?.load) {
    let u = function(...d) {
      for (const l of d) {
        const { href: p } = new URL(l, n);
        c.dependencies.add(p);
      }
    };
    const h = { route: new Proxy(a, { get: (d, l) => (o && (c.route = true), d[l]) }), params: new Proxy(r, { get: (d, l) => (o && c.params.add(l), d[l]) }), data: s?.data ?? null, url: yt(n, () => {
      o && (c.url = true);
    }, (d) => {
      o && c.search_params.add(d);
    }, v.hash), async fetch(d, l) {
      d instanceof Request && (l = { body: d.method === "GET" || d.method === "HEAD" ? void 0 : await d.blob(), cache: d.cache, credentials: d.credentials, headers: [...d.headers].length ? d.headers : void 0, integrity: d.integrity, keepalive: d.keepalive, method: d.method, mode: d.mode, redirect: d.redirect, referrer: d.referrer, referrerPolicy: d.referrerPolicy, signal: d.signal, ...l });
      const { resolved: p, promise: _ } = ct(d, l, n);
      return o && u(p.href), _;
    }, setHeaders: () => {
    }, depends: u, parent() {
      return o && (c.parent = true), t();
    }, untrack(d) {
      o = false;
      try {
        return d();
      } finally {
        o = true;
      }
    } };
    i = await f.universal.load.call(null, h) ?? null;
  }
  return { node: f, loader: e, server: s, universal: f.universal?.load ? { type: "data", data: i, uses: c } : null, data: i ?? s?.data ?? null, slash: f.universal?.trailingSlash ?? s?.slash };
}
function ct(e, t, n) {
  let r = e instanceof Request ? e.url : e;
  const a = new URL(r, n);
  a.origin === n.origin && (r = a.href.slice(n.origin.length));
  const s = se ? kt(r, a.href, t) : St(r, t);
  return { resolved: a, promise: s };
}
function qe(e, t, n, r, a, s) {
  if (xe) return true;
  if (!a) return false;
  if (a.parent && e || a.route && t || a.url && n) return true;
  for (const i of a.search_params) if (r.has(i)) return true;
  for (const i of a.params) if (s[i] !== y.params[i]) return true;
  for (const i of a.dependencies) if (ae.some((o) => o(new URL(i)))) return true;
  return false;
}
function Ne(e, t) {
  return e?.type === "data" ? e : e?.type === "skip" ? t ?? null : null;
}
function an(e, t) {
  if (!e) return new Set(t.searchParams.keys());
  const n = /* @__PURE__ */ new Set([...e.searchParams.keys(), ...t.searchParams.keys()]);
  for (const r of n) {
    const a = e.searchParams.getAll(r), s = t.searchParams.getAll(r);
    a.every((i) => s.includes(i)) && s.every((i) => a.includes(i)) && n.delete(r);
  }
  return n;
}
function Ge({ error: e, url: t, route: n, params: r }) {
  return { type: "loaded", state: { error: e, url: t, route: n, params: r, branch: [] }, props: { page: Oe(k), constructors: [] } };
}
async function lt({ id: e, invalidating: t, url: n, params: r, route: a, preload: s }) {
  if (N?.id === e) return K.delete(N.token), N.promise;
  const { errors: i, layouts: o, leaf: c } = a, f = [...o, c];
  i.forEach((g) => g?.().catch(() => {
  })), f.forEach((g) => g?.[1]().catch(() => {
  }));
  let u = null;
  const h = y.url ? e !== ce(y.url) : false, d = y.route ? a.id !== y.route.id : false, l = an(y.url, n);
  let p = false;
  const _ = f.map((g, w) => {
    const b = y.branch[w], S = !!g?.[0] && (b?.loader !== g[1] || qe(p, d, h, l, b.server?.uses, r));
    return S && (p = true), S;
  });
  if (_.some(Boolean)) {
    try {
      u = await dt(n, _);
    } catch (g) {
      const w = await B(g, { url: n, params: r, route: { id: e } });
      return K.has(s) ? Ge({ error: w, url: n, params: r, route: a }) : ue({ status: ne(g), error: w, url: n, route: a });
    }
    if (u.type === "redirect") return u;
  }
  const m = u?.nodes;
  let R = false;
  const E = f.map(async (g, w) => {
    if (!g) return;
    const b = y.branch[w], S = m?.[w];
    if ((!S || S.type === "skip") && g[1] === b?.loader && !qe(R, d, h, l, b.universal?.uses, r)) return b;
    if (R = true, S?.type === "error") throw S;
    return Ce({ loader: g[1], url: n, params: r, route: a, parent: async () => {
      const he = {};
      for (let pe = 0; pe < w; pe += 1) Object.assign(he, (await E[pe])?.data);
      return he;
    }, server_data_node: Ne(S === void 0 && g[0] ? { type: "skip" } : S ?? null, g[0] ? b?.server : void 0) });
  });
  for (const g of E) g.catch(() => {
  });
  const L = [];
  for (let g = 0; g < f.length; g += 1) if (f[g]) try {
    L.push(await E[g]);
  } catch (w) {
    if (w instanceof Re) return { type: "redirect", location: w.location };
    if (K.has(s)) return Ge({ error: await B(w, { params: r, url: n, route: { id: a.id } }), url: n, params: r, route: a });
    let b = ne(w), S;
    if (m?.includes(w)) b = w.status ?? b, S = w.error;
    else if (w instanceof fe) S = w.body;
    else {
      if (await O.updated.check()) return await et(), await M(n);
      S = await B(w, { params: r, url: n, route: { id: a.id } });
    }
    const Z = await on(g, L, i);
    return Z ? ie({ url: n, params: r, branch: L.slice(0, Z.idx).concat(Z.node), status: b, error: S, route: a }) : await ut(n, { id: a.id }, S, b);
  }
  else L.push(void 0);
  return ie({ url: n, params: r, branch: L, status: 200, error: null, route: a, form: t ? void 0 : null });
}
async function on(e, t, n) {
  for (; e--; ) if (n[e]) {
    let r = e;
    for (; !t[r]; ) r -= 1;
    try {
      return { idx: r + 1, node: { node: await n[e](), loader: n[e], data: {}, server: null, universal: null } };
    } catch {
      continue;
    }
  }
}
async function ue({ status: e, error: t, url: n, route: r }) {
  const a = {};
  let s = null;
  if (v.server_loads[0] === 0) try {
    const o = await dt(n, [true]);
    if (o.type !== "data" || o.nodes[0] && o.nodes[0].type !== "data") throw 0;
    s = o.nodes[0] ?? null;
  } catch {
    (n.origin !== X || n.pathname !== location.pathname || Te) && await M(n);
  }
  try {
    const o = await Ce({ loader: be, url: n, params: a, route: r, parent: () => Promise.resolve({}), server_data_node: Ne(s) }), c = { node: await re(), loader: re, universal: null, server: null, data: null };
    return ie({ url: n, params: a, branch: [o, c], status: e, error: t, route: null });
  } catch (o) {
    if (o instanceof Re) return Pe(new URL(o.location, location.href), {}, 0);
    throw o;
  }
}
async function sn(e) {
  const t = e.href;
  if (Q.has(t)) return Q.get(t);
  let n;
  try {
    const r = (async () => {
      let a = await v.hooks.reroute({ url: new URL(e), fetch: async (s, i) => ct(s, i, e).promise }) ?? e;
      if (typeof a == "string") {
        const s = new URL(e);
        v.hash ? s.hash = a : s.pathname = a, a = s;
      }
      return a;
    })();
    Q.set(t, r), n = await r;
  } catch {
    Q.delete(t);
    return;
  }
  return n;
}
async function de(e, t) {
  if (e && !le(e, U, v.hash)) {
    const n = await sn(e);
    if (!n) return;
    const r = cn(n);
    for (const a of Le) {
      const s = a.exec(r);
      if (s) return { id: ce(e), invalidating: t, route: a, params: wt(s), url: e };
    }
  }
}
function cn(e) {
  return _t(v.hash ? e.hash.replace(/^#/, "").replace(/[?#].+/, "") : e.pathname.slice(U.length)) || "/";
}
function ce(e) {
  return (v.hash ? e.hash.replace(/^#/, "") : e.pathname) + e.search;
}
function ft({ url: e, type: t, intent: n, delta: r }) {
  let a = false;
  const s = pt(y, n, e, t);
  r !== void 0 && (s.navigation.delta = r);
  const i = { ...s.navigation, cancel: () => {
    a = true, s.reject(new Error("navigation cancelled"));
  } };
  return z || tt.forEach((o) => o(i)), a ? null : s;
}
async function ee({ type: e, url: t, popped: n, keepfocus: r, noscroll: a, replace_state: s, state: i = {}, redirect_count: o = 0, nav_token: c = {}, accept: f = Ve, block: u = Ve }) {
  const h = $;
  $ = c;
  const d = await de(t, false), l = ft({ url: t, type: e, delta: n?.delta, intent: d });
  if (!l) {
    u(), $ === c && ($ = h);
    return;
  }
  const p = A, _ = I;
  f(), z = true, se && O.navigating.set(Y.current = l.navigation);
  let m = d && await lt(d);
  if (!m) {
    if (le(t, U, v.hash)) return await M(t);
    m = await ut(t, { id: null }, await B(new Ie(404, "Not Found", `Not found: ${t.pathname}`), { url: t, params: {}, route: { id: null } }), 404);
  }
  if (t = d?.url || t, $ !== c) return l.reject(new Error("navigation aborted")), false;
  if (m.type === "redirect") if (o >= 20) m = await ue({ status: 500, error: await B(new Error("Redirect loop"), { url: t, params: {}, route: { id: null } }), url: t, route: { id: null } });
  else return await Pe(new URL(m.location, t).href, {}, o + 1, c), false;
  else m.props.page.status >= 400 && await O.updated.check() && (await et(), await M(t));
  if (nn(), Ue(p), ot(_), m.props.page.url.pathname !== t.pathname && (t.pathname = m.props.page.url.pathname), i = n ? n.state : i, !n) {
    const g = s ? 0 : 1, w = { [V]: A += g, [W]: I += g, [Ye]: i };
    (s ? history.replaceState : history.pushState).call(history, w, "", t), s || tn(A, I);
  }
  if (N = null, m.props.page.state = i, se) {
    y = m.state, m.props.page && (m.props.page.url = t);
    const g = (await Promise.all(Array.from(nt, (w) => w(l.navigation)))).filter((w) => typeof w == "function");
    if (g.length > 0) {
      let w = function() {
        g.forEach((b) => {
          H.delete(b);
        });
      };
      g.push(w), g.forEach((b) => {
        H.add(b);
      });
    }
    at.$set(m.props), zt(m.props.page), rt = true;
  } else it(m, Ae, false);
  const { activeElement: R } = document;
  await gt();
  const E = n ? n.scroll : a ? Ee() : null;
  if (Be) {
    const g = t.hash && document.getElementById(decodeURIComponent(v.hash ? t.hash.split("#")[2] ?? "" : t.hash.slice(1)));
    E ? scrollTo(E.x, E.y) : g ? g.scrollIntoView() : scrollTo(0, 0);
  }
  const L = document.activeElement !== R && document.activeElement !== document.body;
  !r && !L && gn(), Be = true, m.props.page && Object.assign(k, m.props.page), z = false, e === "popstate" && st(I), l.fulfil(void 0), H.forEach((g) => g(l.navigation)), O.navigating.set(Y.current = null);
}
async function ut(e, t, n, r) {
  return e.origin === X && e.pathname === location.pathname && !Te ? await ue({ status: r, error: n, url: e, route: t }) : await M(e);
}
function ln() {
  let e, t, n;
  C.addEventListener("mousemove", (o) => {
    const c = o.target;
    clearTimeout(e), e = setTimeout(() => {
      s(c, j.hover);
    }, 20);
  });
  function r(o) {
    o.defaultPrevented || s(o.composedPath()[0], j.tap);
  }
  C.addEventListener("mousedown", r), C.addEventListener("touchstart", r, { passive: true });
  const a = new IntersectionObserver((o) => {
    for (const c of o) c.isIntersecting && (we(new URL(c.target.href)), a.unobserve(c.target));
  }, { threshold: 0 });
  async function s(o, c) {
    const f = Xe(o, C), u = f === t && c >= n;
    if (!f || u) return;
    const { url: h, external: d, download: l } = ve(f, U, v.hash);
    if (d || l) return;
    const p = te(f), _ = h && ce(y.url) === ce(h);
    if (!(p.reload || _)) if (c <= p.preload_data) {
      t = f, n = j.tap;
      const m = await de(h, false);
      if (!m) return;
      rn(m);
    } else c <= p.preload_code && (t = f, n = c, we(h));
  }
  function i() {
    a.disconnect();
    for (const o of C.querySelectorAll("a")) {
      const { url: c, external: f, download: u } = ve(o, U, v.hash);
      if (f || u) continue;
      const h = te(o);
      h.reload || (h.preload_code === j.viewport && a.observe(o), h.preload_code === j.eager && we(c));
    }
  }
  H.add(i), i();
}
function B(e, t) {
  if (e instanceof fe) return e.body;
  const n = ne(e), r = Yt(e);
  return v.hooks.handleError({ error: e, event: t, status: n, message: r }) ?? { message: r };
}
function fn(e, t) {
  ye(() => (e.add(t), () => {
    e.delete(t);
  }));
}
function En(e) {
  fn(nt, e);
}
function un(e, t = {}) {
  return e = new URL(Je(e)), e.origin !== X ? Promise.reject(new Error("goto: invalid URL")) : Pe(e, t, 0);
}
function dn(e) {
  if (typeof e == "function") ae.push(e);
  else {
    const { href: t } = new URL(e, location.href);
    ae.push((n) => n.href === t);
  }
}
function hn() {
  history.scrollRestoration = "manual", addEventListener("beforeunload", (t) => {
    let n = false;
    if (Me(), !z) {
      const r = pt(y, void 0, null, "leave"), a = { ...r.navigation, cancel: () => {
        n = true, r.reject(new Error("navigation cancelled"));
      } };
      tt.forEach((s) => s(a));
    }
    n ? (t.preventDefault(), t.returnValue = "") : history.scrollRestoration = "auto";
  }), addEventListener("visibilitychange", () => {
    document.visibilityState === "hidden" && Me();
  }), navigator.connection?.saveData || ln(), C.addEventListener("click", async (t) => {
    if (t.button || t.which !== 1 || t.metaKey || t.ctrlKey || t.shiftKey || t.altKey || t.defaultPrevented) return;
    const n = Xe(t.composedPath()[0], C);
    if (!n) return;
    const { url: r, external: a, target: s, download: i } = ve(n, U, v.hash);
    if (!r) return;
    if (s === "_parent" || s === "_top") {
      if (window.parent !== window) return;
    } else if (s && s !== "_self") return;
    const o = te(n);
    if (!(n instanceof SVGAElement) && r.protocol !== location.protocol && !(r.protocol === "https:" || r.protocol === "http:") || i) return;
    const [f, u] = (v.hash ? r.hash.replace(/^#/, "") : r.href).split("#"), h = f === ge(location);
    if (a || o.reload && (!h || !u)) {
      ft({ url: r, type: "link" }) ? z = true : t.preventDefault();
      return;
    }
    if (u !== void 0 && h) {
      const [, d] = y.url.href.split("#");
      if (d === u) {
        if (t.preventDefault(), u === "" || u === "top" && n.ownerDocument.getElementById("top") === null) window.scrollTo({ top: 0 });
        else {
          const l = n.ownerDocument.getElementById(decodeURIComponent(u));
          l && (l.scrollIntoView(), l.focus());
        }
        return;
      }
      if (q = true, Ue(A), e(r), !o.replace_state) return;
      q = false;
    }
    t.preventDefault(), await new Promise((d) => {
      requestAnimationFrame(() => {
        setTimeout(d, 0);
      }), setTimeout(d, 100);
    }), await ee({ type: "link", url: r, keepfocus: o.keepfocus, noscroll: o.noscroll, replace_state: o.replace_state ?? r.href === location.href });
  }), C.addEventListener("submit", (t) => {
    if (t.defaultPrevented) return;
    const n = HTMLFormElement.prototype.cloneNode.call(t.target), r = t.submitter;
    if ((r?.formTarget || n.target) === "_blank" || (r?.formMethod || n.method) !== "get") return;
    const i = new URL(r?.hasAttribute("formaction") && r?.formAction || n.action);
    if (le(i, U, false)) return;
    const o = t.target, c = te(o);
    if (c.reload) return;
    t.preventDefault(), t.stopPropagation();
    const f = new FormData(o), u = r?.getAttribute("name");
    u && f.append(u, r?.getAttribute("value") ?? ""), i.search = new URLSearchParams(f).toString(), ee({ type: "form", url: i, keepfocus: c.keepfocus, noscroll: c.noscroll, replace_state: c.replace_state ?? i.href === location.href });
  }), addEventListener("popstate", async (t) => {
    if (t.state?.[V]) {
      const n = t.state[V];
      if ($ = {}, n === A) return;
      const r = D[n], a = t.state[Ye] ?? {}, s = new URL(t.state[Ct] ?? location.href), i = t.state[W], o = y.url ? ge(location) === ge(y.url) : false;
      if (i === I && (rt || o)) {
        a !== k.state && (k.state = a), e(s), D[A] = Ee(), r && scrollTo(r.x, r.y), A = n;
        return;
      }
      const f = n - A;
      await ee({ type: "popstate", url: s, popped: { state: a, scroll: r, delta: f }, accept: () => {
        A = n, I = i;
      }, block: () => {
        history.go(-f);
      }, nav_token: $ });
    } else if (!q) {
      const n = new URL(location.href);
      e(n), v.hash && location.reload();
    }
  }), addEventListener("hashchange", () => {
    q && (q = false, history.replaceState({ ...history.state, [V]: ++A, [W]: I }, "", location.href));
  });
  for (const t of document.querySelectorAll("link")) en.has(t.rel) && (t.href = t.href);
  addEventListener("pageshow", (t) => {
    t.persisted && O.navigating.set(Y.current = null);
  });
  function e(t) {
    y.url = k.url = t, O.page.set(Oe(k)), O.page.notify();
  }
}
async function pn(e, { status: t = 200, error: n, node_ids: r, params: a, route: s, server_route: i, data: o, form: c }) {
  Te = true;
  const f = new URL(location.href);
  let u;
  ({ params: a = {}, route: s = { id: null } } = await de(f, false) || {}), u = Le.find(({ id: l }) => l === s.id);
  let h, d = true;
  try {
    const l = r.map(async (_, m) => {
      const R = o[m];
      return R?.uses && (R.uses = ht(R.uses)), Ce({ loader: v.nodes[_], url: f, params: a, route: s, parent: async () => {
        const E = {};
        for (let L = 0; L < m; L += 1) Object.assign(E, (await l[L]).data);
        return E;
      }, server_data_node: Ne(R) });
    }), p = await Promise.all(l);
    if (u) {
      const _ = u.layouts;
      for (let m = 0; m < _.length; m++) _[m] || p.splice(m, 0, void 0);
    }
    h = ie({ url: f, params: a, branch: p, status: t, error: n, form: c, route: u ?? null });
  } catch (l) {
    if (l instanceof Re) {
      await M(new URL(l.location, location.href));
      return;
    }
    h = await ue({ status: ne(l), error: await B(l, { url: f, params: a, route: s }), url: f, route: s }), e.textContent = "", d = false;
  }
  h.props.page && (h.props.page.state = {}), it(h, e, d);
}
async function dt(e, t) {
  const n = new URL(e);
  n.pathname = Qt(e.pathname), e.pathname.endsWith("/") && n.searchParams.append(Wt, "1"), n.searchParams.append(Kt, t.map((s) => s ? "1" : "0").join(""));
  const r = window.fetch, a = await r(n.href, {});
  if (!a.ok) {
    let s;
    throw a.headers.get("content-type")?.includes("application/json") ? s = await a.json() : a.status === 404 ? s = "Not Found" : a.status === 500 && (s = "Internal Error"), new fe(a.status, s);
  }
  return new Promise(async (s) => {
    const i = /* @__PURE__ */ new Map(), o = a.body.getReader(), c = new TextDecoder();
    function f(h) {
      return qt(h, { ...v.decoders, Promise: (d) => new Promise((l, p) => {
        i.set(d, { fulfil: l, reject: p });
      }) });
    }
    let u = "";
    for (; ; ) {
      const { done: h, value: d } = await o.read();
      if (h && !u) break;
      for (u += !d && u ? `
` : c.decode(d, { stream: true }); ; ) {
        const l = u.indexOf(`
`);
        if (l === -1) break;
        const p = JSON.parse(u.slice(0, l));
        if (u = u.slice(l + 1), p.type === "redirect") return s(p);
        if (p.type === "data") p.nodes?.forEach((_) => {
          _?.type === "data" && (_.uses = ht(_.uses), _.data = f(_.data));
        }), s(p);
        else if (p.type === "chunk") {
          const { id: _, data: m, error: R } = p, E = i.get(_);
          i.delete(_), R ? E.reject(f(R)) : E.fulfil(f(m));
        }
      }
    }
  });
}
function ht(e) {
  return { dependencies: new Set(e?.dependencies ?? []), params: new Set(e?.params ?? []), parent: !!e?.parent, route: !!e?.route, url: !!e?.url, search_params: new Set(e?.search_params ?? []) };
}
function gn() {
  const e = document.querySelector("[autofocus]");
  if (e) e.focus();
  else {
    const t = document.body, n = t.getAttribute("tabindex");
    t.tabIndex = -1, t.focus({ preventScroll: true, focusVisible: false }), n !== null ? t.setAttribute("tabindex", n) : t.removeAttribute("tabindex");
    const r = getSelection();
    if (r && r.type !== "None") {
      const a = [];
      for (let s = 0; s < r.rangeCount; s += 1) a.push(r.getRangeAt(s));
      setTimeout(() => {
        if (r.rangeCount === a.length) {
          for (let s = 0; s < r.rangeCount; s += 1) {
            const i = a[s], o = r.getRangeAt(s);
            if (i.commonAncestorContainer !== o.commonAncestorContainer || i.startContainer !== o.startContainer || i.endContainer !== o.endContainer || i.startOffset !== o.startOffset || i.endOffset !== o.endOffset) return;
          }
          r.removeAllRanges();
        }
      });
    }
  }
}
function pt(e, t, n, r) {
  let a, s;
  const i = new Promise((c, f) => {
    a = c, s = f;
  });
  return i.catch(() => {
  }), { navigation: { from: { params: e.params, route: { id: e.route?.id ?? null }, url: e.url }, to: n && { params: t?.params ?? null, route: { id: t?.route?.id ?? null }, url: n }, willUnload: !t, type: r, complete: i }, fulfil: a, reject: s };
}
function Oe(e) {
  return { data: e.data, error: e.error, form: e.form, params: e.params, route: e.route, state: e.state, status: e.status, url: e.url };
}
function mn(e) {
  const t = new URL(e);
  return t.hash = decodeURIComponent(e.hash), t;
}
export {
  kn as a,
  un as g,
  vn as l,
  En as o,
  k as p,
  O as s
};
