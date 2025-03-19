import { q as M, z as pe, aV as Qe, aW as Nt, ax as At, k as $e, G as et, l as tt, v as oe, a5 as It, E as _t, aX as Ct, y as Ot, w as xt, C as Be, x as je, K as Rt, F as Pt, o as Ft, a0 as Ie, ad as Lt, N as J, g as m, b as S, d as k, e as ee, _ as Dt, u as W, aY as Mt, i as Ue, j as kt, aN as Bt, p as K, f as P, a as V, m as G, aZ as jt, aU as Ut, t as Wt } from "./BMAj9zKA.js";
import { m as Kt, l as Vt, o as _ } from "./BSdt-dIf.js";
import { e as he, b as Gt } from "./DjDC-EQm.js";
import "./NZTpNUN0.js";
import { b as Ht, c as F, a as L } from "./pDBoOQRd.js";
import { i as nt } from "./BA1UOs1h.js";
import { s as H } from "./k4NpJaFV.js";
import { p as A } from "./Baj-A2iI.js";
import { c as We, m as zt, u as qt } from "./DzGbYseb.js";
import { p as T, r as Xt } from "./D_-9kNr4.js";
import { u as te, c as Yt, __tla as __tla_0 } from "./BUkYaDtB.js";
import { g as Zt } from "./D7Oepc1u.js";
import { b as Jt } from "./BUHZJKy3.js";
let rr, Te, Ui, Gn, Pi, Ni, ki, Xn, Ii, qn, Ai, Hn, ut, Ti, Vn, He, Ri, Bn, li, _i, Bi, re, Ci, ot, bi, er, z, lt, xe, Li, Di, Lr, yt, Mi, $t, Qt, ai, Si, wi, mi, Ei, pi, Oi, ct, v, yi, gi, fi, R, dn, ui, di, hi, vi, fe, ci, xi, x, Fi, ji, Se;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  Qt = function(t, e, n) {
    M && pe();
    var r = t, i = It, s, o = Qe() ? Nt : At;
    $e(() => {
      o(i, i = e()) && (s && et(s), s = tt(() => n(r)));
    }), M && (r = oe);
  };
  $t = function(t, e, n, r, i, s) {
    let o = M;
    M && pe();
    var a, u, c = null;
    M && oe.nodeType === 1 && (c = oe, pe());
    var f = M ? oe : t, l;
    $e(() => {
      const d = e() || null;
      var p = d === "svg" ? Ct : null;
      d !== a && (l && (d === null ? et(l, () => {
        l = null, u = null;
      }) : d === u ? Pt(l) : (Ft(l), We(false))), d && d !== u && (l = tt(() => {
        if (c = M ? c : p ? document.createElementNS(p, d) : document.createElement(d), Ht(c, c), r) {
          M && Kt(d) && c.append(document.createComment(""));
          var N = M ? Ot(c) : c.appendChild(xt());
          M && (N === null ? Be(false) : je(N)), r(c, N);
        }
        Rt.nodes_end = c, f.before(c);
      })), a = d, a && (u = a), We(true));
    }, _t), o && (Be(true), je(f));
  };
  ai = function(t, e, n = e) {
    var r = Qe();
    Vt(t, "input", (i) => {
      var s = i ? t.defaultValue : t.value;
      if (s = ve(t) ? me(s) : s, n(s), r && s !== (s = e())) {
        var o = t.selectionStart, a = t.selectionEnd;
        t.value = s ?? "", a !== null && (t.selectionStart = o, t.selectionEnd = Math.min(a, t.value.length));
      }
    }), (M && t.defaultValue !== t.value || Ie(e) == null && t.value) && n(ve(t) ? me(t.value) : t.value), Lt(() => {
      var i = e();
      ve(t) && i === me(t.value) || t.type === "date" && !i && !t.value || i !== t.value && (t.value = i ?? "");
    });
  };
  function ve(t) {
    var e = t.type;
    return e === "number" || e === "range";
  }
  function me(t) {
    return t === "" ? null : +t;
  }
  function be(t) {
    if (!_e(t)) throw new Error("Parameter was not an error");
  }
  function _e(t) {
    return !!t && typeof t == "object" && en(t) === "[object Error]" || t instanceof Error;
  }
  function en(t) {
    return Object.prototype.toString.call(t);
  }
  const tn = "Layerr";
  let nn = tn;
  function rn() {
    return nn;
  }
  function sn(t) {
    let e, n = "";
    if (t.length === 0) e = {};
    else if (_e(t[0])) e = {
      cause: t[0]
    }, n = t.slice(1).join(" ") || "";
    else if (t[0] && typeof t[0] == "object") e = Object.assign({}, t[0]), n = t.slice(1).join(" ") || "";
    else if (typeof t[0] == "string") e = {}, n = n = t.join(" ") || "";
    else throw new Error("Invalid arguments passed to Layerr");
    return {
      options: e,
      shortMessage: n
    };
  }
  class O extends Error {
    constructor(e, n) {
      const r = [
        ...arguments
      ], { options: i, shortMessage: s } = sn(r);
      let o = s;
      if (i.cause && (o = `${o}: ${i.cause.message}`), super(o), this.message = o, i.name && typeof i.name == "string" ? this.name = i.name : this.name = rn(), i.cause && Object.defineProperty(this, "_cause", {
        value: i.cause
      }), Object.defineProperty(this, "_info", {
        value: {}
      }), i.info && typeof i.info == "object" && Object.assign(this._info, i.info), Error.captureStackTrace) {
        const a = i.constructorOpt || this.constructor;
        Error.captureStackTrace(this, a);
      }
    }
    static cause(e) {
      return be(e), e._cause && _e(e._cause) ? e._cause : null;
    }
    static fullStack(e) {
      be(e);
      const n = O.cause(e);
      return n ? `${e.stack}
caused by: ${O.fullStack(n)}` : e.stack ?? "";
    }
    static info(e) {
      be(e);
      const n = {}, r = O.cause(e);
      return r && Object.assign(n, O.info(r)), e._info && Object.assign(n, e._info), n;
    }
    toString() {
      let e = this.name || this.constructor.name || this.constructor.prototype.name;
      return this.message && (e = `${e}: ${this.message}`), e;
    }
  }
  const Ce = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", $ = 32, ye = 281474976710655, Ee = 10, rt = 16, U = Object.freeze({
    source: "ulid"
  });
  ui = function(t) {
    if (t.length !== Ee + rt) throw new O({
      info: {
        code: "DEC_TIME_MALFORMED",
        ...U
      }
    }, "Malformed ULID");
    const e = t.substr(0, Ee).toUpperCase().split("").reverse().reduce((n, r, i) => {
      const s = Ce.indexOf(r);
      if (s === -1) throw new O({
        info: {
          code: "DEC_TIME_CHAR",
          ...U
        }
      }, `Time decode error: Invalid character: ${r}`);
      return n += s * Math.pow($, i);
    }, 0);
    if (e > ye) throw new O({
      info: {
        code: "DEC_TIME_CHAR",
        ...U
      }
    }, `Malformed ULID: timestamp too large: ${e}`);
    return e;
  };
  function on(t) {
    const e = an(), n = e && (e.crypto || e.msCrypto) || null;
    if (typeof n?.getRandomValues == "function") return () => {
      const r = new Uint8Array(1);
      return n.getRandomValues(r), r[0] / 255;
    };
    if (typeof n?.randomBytes == "function") return () => n.randomBytes(1).readUInt8() / 255;
    throw new O({
      info: {
        code: "PRNG_DETECT",
        ...U
      }
    }, "Failed to find a reliable PRNG");
  }
  function an() {
    return ln() ? self : typeof window < "u" ? window : typeof global < "u" ? global : typeof globalThis < "u" ? globalThis : null;
  }
  function un(t, e) {
    let n = "";
    for (; t > 0; t--) n = fn(e) + n;
    return n;
  }
  function cn(t, e) {
    if (isNaN(t)) throw new O({
      info: {
        code: "ENC_TIME_NAN",
        ...U
      }
    }, `Time must be a number: ${t}`);
    if (t > ye) throw new O({
      info: {
        code: "ENC_TIME_SIZE_EXCEED",
        ...U
      }
    }, `Cannot encode a time larger than ${ye}: ${t}`);
    if (t < 0) throw new O({
      info: {
        code: "ENC_TIME_NEG",
        ...U
      }
    }, `Time must be positive: ${t}`);
    if (Number.isInteger(t) === false) throw new O({
      info: {
        code: "ENC_TIME_TYPE",
        ...U
      }
    }, `Time must be an integer: ${t}`);
    let n, r = "";
    for (let i = e; i > 0; i--) n = t % $, r = Ce.charAt(n) + r, t = (t - n) / $;
    return r;
  }
  function ln() {
    return typeof WorkerGlobalScope < "u" && self instanceof WorkerGlobalScope;
  }
  function fn(t) {
    let e = Math.floor(t() * $);
    return e === $ && (e = $ - 1), Ce.charAt(e);
  }
  ci = function(t, e) {
    const n = e || on(), r = isNaN(t) ? Date.now() : t;
    return cn(r, Ee) + un(rt, n);
  };
  dn = class extends Map {
    #t = /* @__PURE__ */ new Map();
    #e = J(0);
    #n = J(0);
    constructor(e) {
      if (super(), e) {
        for (var [n, r] of e) super.set(n, r);
        this.#n.v = super.size;
      }
    }
    has(e) {
      var n = this.#t, r = n.get(e);
      if (r === void 0) {
        var i = super.get(e);
        if (i !== void 0) r = J(0), n.set(e, r);
        else return m(this.#e), false;
      }
      return m(r), true;
    }
    forEach(e, n) {
      this.#r(), super.forEach(e, n);
    }
    get(e) {
      var n = this.#t, r = n.get(e);
      if (r === void 0) {
        var i = super.get(e);
        if (i !== void 0) r = J(0), n.set(e, r);
        else {
          m(this.#e);
          return;
        }
      }
      return m(r), super.get(e);
    }
    set(e, n) {
      var r = this.#t, i = r.get(e), s = super.get(e), o = super.set(e, n), a = this.#e;
      if (i === void 0) r.set(e, J(0)), S(this.#n, super.size), te(a);
      else if (s !== n) {
        te(i);
        var u = a.reactions === null ? null : new Set(a.reactions), c = u === null || !i.reactions?.every((f) => u.has(f));
        c && te(a);
      }
      return o;
    }
    delete(e) {
      var n = this.#t, r = n.get(e), i = super.delete(e);
      return r !== void 0 && (n.delete(e), S(this.#n, super.size), S(r, -1), te(this.#e)), i;
    }
    clear() {
      if (super.size !== 0) {
        super.clear();
        var e = this.#t;
        S(this.#n, 0);
        for (var n of e.values()) S(n, -1);
        te(this.#e), e.clear();
      }
    }
    #r() {
      m(this.#e);
      var e = this.#t;
      if (this.#n.v !== e.size) for (var n of super.keys()) e.has(n) || e.set(n, J(0));
      for (var [, r] of this.#t) m(r);
    }
    keys() {
      return m(this.#e), super.keys();
    }
    values() {
      return this.#r(), super.values();
    }
    entries() {
      return this.#r(), super.entries();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get size() {
      return m(this.#n), super.size;
    }
  };
  function hn(t) {
    return typeof t == "function";
  }
  function vn(t) {
    return t !== null && typeof t == "object";
  }
  const mn = [
    "string",
    "number",
    "bigint",
    "boolean"
  ];
  function we(t) {
    return t == null || mn.includes(typeof t) ? true : Array.isArray(t) ? t.every((e) => we(e)) : typeof t == "object" ? Object.getPrototypeOf(t) === Object.prototype : false;
  }
  const ne = Symbol("box"), Oe = Symbol("is-writable");
  function bn(t) {
    return vn(t) && ne in t;
  }
  function gn(t) {
    return v.isBox(t) && Oe in t;
  }
  v = function(t) {
    let e = k(A(t));
    return {
      [ne]: true,
      [Oe]: true,
      get current() {
        return m(e);
      },
      set current(n) {
        S(e, A(n));
      }
    };
  };
  function pn(t, e) {
    const n = ee(t);
    return e ? {
      [ne]: true,
      [Oe]: true,
      get current() {
        return m(n);
      },
      set current(r) {
        e(r);
      }
    } : {
      [ne]: true,
      get current() {
        return t();
      }
    };
  }
  function yn(t) {
    return v.isBox(t) ? t : hn(t) ? v.with(t) : v(t);
  }
  function En(t) {
    return Object.entries(t).reduce((e, [n, r]) => v.isBox(r) ? (v.isWritableBox(r) ? Object.defineProperty(e, n, {
      get() {
        return r.current;
      },
      set(i) {
        r.current = i;
      }
    }) : Object.defineProperty(e, n, {
      get() {
        return r.current;
      }
    }), e) : Object.assign(e, {
      [n]: r
    }), {});
  }
  function wn(t) {
    return v.isWritableBox(t) ? {
      [ne]: true,
      get current() {
        return t.current;
      }
    } : t;
  }
  v.from = yn;
  v.with = pn;
  v.flatten = En;
  v.readonly = wn;
  v.isBox = bn;
  v.isWritableBox = gn;
  function it(...t) {
    return function(e) {
      for (const n of t) if (n) {
        if (e.defaultPrevented) return;
        typeof n == "function" ? n.call(this, e) : n.current?.call(this, e);
      }
    };
  }
  var Q = {}, ge, Ke;
  function Sn() {
    if (Ke) return ge;
    Ke = 1;
    var t = /\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, e = /\n/g, n = /^\s*/, r = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/, i = /^:\s*/, s = /^((?:'(?:\\'|.)*?'|"(?:\\"|.)*?"|\([^)]*?\)|[^};])+)/, o = /^[;\s]*/, a = /^\s+|\s+$/g, u = `
`, c = "/", f = "*", l = "", d = "comment", p = "declaration";
    ge = function(y, C) {
      if (typeof y != "string") throw new TypeError("First argument must be a string");
      if (!y) return [];
      C = C || {};
      var h = 1, g = 1;
      function w(E) {
        var b = E.match(e);
        b && (h += b.length);
        var D = E.lastIndexOf(u);
        g = ~D ? E.length - D : g + E.length;
      }
      function I() {
        var E = {
          line: h,
          column: g
        };
        return function(b) {
          return b.position = new X(E), De(), b;
        };
      }
      function X(E) {
        this.start = E, this.end = {
          line: h,
          column: g
        }, this.source = C.source;
      }
      X.prototype.content = y;
      function Y(E) {
        var b = new Error(C.source + ":" + h + ":" + g + ": " + E);
        if (b.reason = E, b.filename = C.source, b.line = h, b.column = g, b.source = y, !C.silent) throw b;
      }
      function Z(E) {
        var b = E.exec(y);
        if (b) {
          var D = b[0];
          return w(D), y = y.slice(D.length), b;
        }
      }
      function De() {
        Z(n);
      }
      function Me(E) {
        var b;
        for (E = E || []; b = ke(); ) b !== false && E.push(b);
        return E;
      }
      function ke() {
        var E = I();
        if (!(c != y.charAt(0) || f != y.charAt(1))) {
          for (var b = 2; l != y.charAt(b) && (f != y.charAt(b) || c != y.charAt(b + 1)); ) ++b;
          if (b += 2, l === y.charAt(b - 1)) return Y("End of comment missing");
          var D = y.slice(2, b - 2);
          return g += 2, w(D), y = y.slice(b), g += 2, E({
            type: d,
            comment: D
          });
        }
      }
      function wt() {
        var E = I(), b = Z(r);
        if (b) {
          if (ke(), !Z(i)) return Y("property missing ':'");
          var D = Z(s), Tt = E({
            type: p,
            property: N(b[0].replace(t, l)),
            value: D ? N(D[0].replace(t, l)) : l
          });
          return Z(o), Tt;
        }
      }
      function St() {
        var E = [];
        Me(E);
        for (var b; b = wt(); ) b !== false && (E.push(b), Me(E));
        return E;
      }
      return De(), St();
    };
    function N(y) {
      return y ? y.replace(a, l) : l;
    }
    return ge;
  }
  var Ve;
  function Tn() {
    if (Ve) return Q;
    Ve = 1;
    var t = Q && Q.__importDefault || function(r) {
      return r && r.__esModule ? r : {
        default: r
      };
    };
    Object.defineProperty(Q, "__esModule", {
      value: true
    }), Q.default = n;
    var e = t(Sn());
    function n(r, i) {
      var s = null;
      if (!r || typeof r != "string") return s;
      var o = (0, e.default)(r), a = typeof i == "function";
      return o.forEach(function(u) {
        if (u.type === "declaration") {
          var c = u.property, f = u.value;
          a ? i(c, f, u) : f && (s = s || {}, s[c] = f);
        }
      }), s;
    }
    return Q;
  }
  var Nn = Tn();
  const Ge = Zt(Nn), An = Ge.default || Ge, In = /\d/, _n = [
    "-",
    "_",
    "/",
    "."
  ];
  function Cn(t = "") {
    if (!In.test(t)) return t !== t.toLowerCase();
  }
  function On(t) {
    const e = [];
    let n = "", r, i;
    for (const s of t) {
      const o = _n.includes(s);
      if (o === true) {
        e.push(n), n = "", r = void 0;
        continue;
      }
      const a = Cn(s);
      if (i === false) {
        if (r === false && a === true) {
          e.push(n), n = s, r = a;
          continue;
        }
        if (r === true && a === false && n.length > 1) {
          const u = n.at(-1);
          e.push(n.slice(0, Math.max(0, n.length - 1))), n = u + s, r = a;
          continue;
        }
      }
      n += s, r = a, i = o;
    }
    return e.push(n), e;
  }
  function st(t) {
    return t ? On(t).map((e) => Rn(e)).join("") : "";
  }
  function xn(t) {
    return Pn(st(t || ""));
  }
  function Rn(t) {
    return t ? t[0].toUpperCase() + t.slice(1) : "";
  }
  function Pn(t) {
    return t ? t[0].toLowerCase() + t.slice(1) : "";
  }
  re = function(t) {
    if (!t) return {};
    const e = {};
    function n(r, i) {
      if (r.startsWith("-moz-") || r.startsWith("-webkit-") || r.startsWith("-ms-") || r.startsWith("-o-")) {
        e[st(r)] = i;
        return;
      }
      if (r.startsWith("--")) {
        e[r] = i;
        return;
      }
      e[xn(r)] = i;
    }
    return An(t, n), e;
  };
  z = function(...t) {
    return (...e) => {
      for (const n of t) typeof n == "function" && n(...e);
    };
  };
  function Fn(t, e) {
    const n = RegExp(t, "g");
    return (r) => {
      if (typeof r != "string") throw new TypeError(`expected an argument of type string, but got ${typeof r}`);
      return r.match(n) ? r.replace(n, e) : r;
    };
  }
  const Ln = Fn(/[A-Z]/, (t) => `-${t.toLowerCase()}`);
  function Dn(t) {
    if (!t || typeof t != "object" || Array.isArray(t)) throw new TypeError(`expected an argument of type object, but got ${typeof t}`);
    return Object.keys(t).map((e) => `${Ln(e)}: ${t[e]};`).join(`
`);
  }
  ot = function(t = {}) {
    return Dn(t).replace(`
`, " ");
  };
  let Mn;
  Mn = {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    transform: "translateX(-100%)"
  };
  li = ot(Mn);
  function kn(t) {
    return t.length > 2 && t.startsWith("on") && t[2] === t[2]?.toLowerCase();
  }
  fi = function(...t) {
    const e = {
      ...t[0]
    };
    for (let n = 1; n < t.length; n++) {
      const r = t[n];
      for (const i in r) {
        const s = e[i], o = r[i], a = typeof s == "function", u = typeof o == "function";
        if (a && kn(i)) {
          const c = s, f = o;
          e[i] = it(c, f);
        } else if (a && u) e[i] = z(s, o);
        else if (i === "class") {
          const c = we(s), f = we(o);
          c && f ? e[i] = he(s, o) : c ? e[i] = he(s) : f && (e[i] = he(o));
        } else if (i === "style") {
          const c = typeof s == "object", f = typeof o == "object", l = typeof s == "string", d = typeof o == "string";
          if (c && f) e[i] = {
            ...s,
            ...o
          };
          else if (c && d) {
            const p = re(o);
            e[i] = {
              ...s,
              ...p
            };
          } else if (l && f) {
            const p = re(s);
            e[i] = {
              ...p,
              ...o
            };
          } else if (l && d) {
            const p = re(s), N = re(o);
            e[i] = {
              ...p,
              ...N
            };
          } else c ? e[i] = s : f ? e[i] = o : l ? e[i] = s : d && (e[i] = o);
        } else e[i] = o !== void 0 ? o : s;
      }
    }
    return typeof e.style == "object" && (e.style = ot(e.style).replaceAll(`
`, " ")), e.hidden !== true && (e.hidden = void 0, delete e.hidden), e.disabled !== true && (e.disabled = void 0, delete e.disabled), e;
  };
  Bn = typeof window < "u" ? window : void 0;
  function jn(t) {
    let e = t.activeElement;
    for (; e?.shadowRoot; ) {
      const n = e.shadowRoot.activeElement;
      if (n === e) break;
      e = n;
    }
    return e;
  }
  class Un {
    #t;
    #e;
    constructor(e = {}) {
      const { window: n = Bn, document: r = n?.document } = e;
      n !== void 0 && (this.#t = r, this.#e = Yt((i) => {
        const s = _(n, "focusin", i), o = _(n, "focusout", i);
        return () => {
          s(), o();
        };
      }));
    }
    get current() {
      return this.#e?.(), this.#t ? jn(this.#t) : null;
    }
  }
  new Un();
  function Wn(t, e) {
    switch (t) {
      case "post":
        W(e);
        break;
      case "pre":
        Dt(e);
        break;
    }
  }
  function at(t, e, n, r = {}) {
    const { lazy: i = false } = r;
    let s = !i, o = Array.isArray(t) ? [] : void 0;
    Wn(e, () => {
      const a = Array.isArray(t) ? t.map((c) => c()) : t();
      if (!s) {
        s = true, o = a;
        return;
      }
      const u = Ie(() => n(a, o));
      return o = a, u;
    });
  }
  x = function(t, e, n) {
    at(t, "post", e, n);
  };
  function Kn(t, e, n) {
    at(t, "pre", e, n);
  }
  x.pre = Kn;
  Vn = class {
    #t = k(void 0);
    #e;
    constructor(e) {
      W(() => {
        S(this.#t, A(this.#e)), this.#e = e();
      });
    }
    get current() {
      return m(this.#t);
    }
  };
  Gn = class {
    #t;
    #e;
    constructor(e) {
      this.#t = e, this.#e = Symbol(e);
    }
    get key() {
      return this.#e;
    }
    exists() {
      return Mt(this.#e);
    }
    get() {
      const e = Ue(this.#e);
      if (e === void 0) throw new Error(`Context "${this.#t}" not found`);
      return e;
    }
    getOr(e) {
      const n = Ue(this.#e);
      return n === void 0 ? e : n;
    }
    set(e) {
      return kt(this.#e, e);
    }
  };
  ut = function(t) {
    W(() => () => {
      t();
    });
  };
  xe = function({ id: t, ref: e, deps: n = () => true, onRefChange: r, getRootNode: i }) {
    x([
      () => t.current,
      n
    ], ([s]) => {
      const a = (i?.() ?? document)?.getElementById(s);
      a ? e.current = a : e.current = null, r?.(e.current);
    }), ut(() => {
      e.current = null, r?.(null);
    });
  };
  function Re(t, e) {
    return setTimeout(e, t);
  }
  fe = function(t) {
    Bt().then(t);
  };
  di = function(t) {
    return t ? "open" : "closed";
  };
  hi = function(t) {
    return t ? "true" : "false";
  };
  vi = function(t) {
    return t ? "true" : "false";
  };
  mi = function(t) {
    return t ? "" : void 0;
  };
  bi = function(t) {
    return t ? "true" : "false";
  };
  gi = function(t) {
    return t ? "true" : "false";
  };
  pi = function(t, e) {
    return e ? "mixed" : t ? "true" : "false";
  };
  yi = function(t) {
    return t;
  };
  Ei = function(t) {
    return t;
  };
  wi = function(t) {
    return t ? true : void 0;
  };
  Si = function(t) {
    return t ? "true" : "false";
  };
  Ti = function(t) {
    return t ? true : void 0;
  };
  let Pe, Fe, zn;
  Se = "ArrowDown";
  Pe = "ArrowLeft";
  Fe = "ArrowRight";
  Te = "ArrowUp";
  Hn = "End";
  Ni = "Enter";
  zn = "Escape";
  qn = "Home";
  Ai = "PageDown";
  Ii = "PageUp";
  _i = " ";
  Xn = "Tab";
  function Yn(t) {
    return window.getComputedStyle(t).getPropertyValue("direction");
  }
  function Zn(t = "ltr", e = "horizontal") {
    return {
      horizontal: t === "rtl" ? Pe : Fe,
      vertical: Se
    }[e];
  }
  function Jn(t = "ltr", e = "horizontal") {
    return {
      horizontal: t === "rtl" ? Fe : Pe,
      vertical: Te
    }[e];
  }
  function Qn(t = "ltr", e = "horizontal") {
    return [
      "ltr",
      "rtl"
    ].includes(t) || (t = "ltr"), [
      "horizontal",
      "vertical"
    ].includes(e) || (e = "horizontal"), {
      nextKey: Zn(t, e),
      prevKey: Jn(t, e)
    };
  }
  let de;
  de = typeof document < "u";
  He = $n();
  function $n() {
    return de && window?.navigator?.userAgent && (/iP(ad|hone|od)/.test(window.navigator.userAgent) || window?.navigator?.maxTouchPoints > 2 && /iPad|Macintosh/.test(window?.navigator.userAgent));
  }
  function Ne(t) {
    return t instanceof HTMLElement;
  }
  er = function(t) {
    return t instanceof Element;
  };
  Ci = function(t) {
    return t !== null;
  };
  function tr(t) {
    return t instanceof HTMLInputElement && "select" in t;
  }
  function nr(t, e) {
    if (getComputedStyle(t).visibility === "hidden") return true;
    for (; t; ) {
      if (e !== void 0 && t === e) return false;
      if (getComputedStyle(t).display === "none") return true;
      t = t.parentElement;
    }
    return false;
  }
  Oi = function(t) {
    const e = v(null);
    function n() {
      if (!de) return [];
      const o = document.getElementById(t.rootNodeId.current);
      return o ? t.candidateSelector ? Array.from(o.querySelectorAll(t.candidateSelector)) : Array.from(o.querySelectorAll(`[${t.candidateAttr}]:not([data-disabled])`)) : [];
    }
    function r() {
      const o = n();
      o.length && o[0]?.focus();
    }
    function i(o, a, u = false) {
      const c = document.getElementById(t.rootNodeId.current);
      if (!c || !o) return;
      const f = n();
      if (!f.length) return;
      const l = f.indexOf(o), d = Yn(c), { nextKey: p, prevKey: N } = Qn(d, t.orientation.current), y = t.loop.current, C = {
        [p]: l + 1,
        [N]: l - 1,
        [qn]: 0,
        [Hn]: f.length - 1
      };
      if (u) {
        const w = p === Se ? Fe : Se, I = N === Te ? Pe : Te;
        C[w] = l + 1, C[I] = l - 1;
      }
      let h = C[a.key];
      if (h === void 0) return;
      a.preventDefault(), h < 0 && y ? h = f.length - 1 : h === f.length && y && (h = 0);
      const g = f[h];
      if (g) return g.focus(), e.current = g.id, t.onCandidateFocus?.(g), g;
    }
    function s(o) {
      const a = n(), u = e.current !== null;
      return o && !u && a[0] === o ? (e.current = o.id, 0) : o?.id === e.current ? 0 : -1;
    }
    return {
      setCurrentTabStopId(o) {
        e.current = o;
      },
      getTabIndex: s,
      handleKeydown: i,
      focusFirstCandidate: r,
      currentTabStopId: e
    };
  };
  globalThis.bitsIdCounter ??= {
    current: 0
  };
  ct = function(t = "bits") {
    return globalThis.bitsIdCounter.current++, `${t}-${globalThis.bitsIdCounter.current}`;
  };
  R = function() {
  };
  rr = function(t, e) {
    const n = v(t);
    function r(s) {
      return e[n.current][s] ?? n.current;
    }
    return {
      state: n,
      dispatch: (s) => {
        n.current = r(s);
      }
    };
  };
  function ir(t, e) {
    let n = k(A({})), r = k("none");
    const i = t.current ? "mounted" : "unmounted";
    let s = k(null);
    const o = new Vn(() => t.current);
    x([
      () => e.current,
      () => t.current
    ], ([d, p]) => {
      !d || !p || fe(() => {
        S(s, A(document.getElementById(d)));
      });
    });
    const { state: a, dispatch: u } = rr(i, {
      mounted: {
        UNMOUNT: "unmounted",
        ANIMATION_OUT: "unmountSuspended"
      },
      unmountSuspended: {
        MOUNT: "mounted",
        ANIMATION_END: "unmounted"
      },
      unmounted: {
        MOUNT: "mounted"
      }
    });
    x(() => t.current, (d) => {
      if (m(s) || S(s, A(document.getElementById(e.current))), !m(s) || !(d !== o.current)) return;
      const N = m(r), y = ie(m(s));
      d ? u("MOUNT") : y === "none" || m(n).display === "none" ? u("UNMOUNT") : u(o && N !== y ? "ANIMATION_OUT" : "UNMOUNT");
    });
    function c(d) {
      if (m(s) || S(s, A(document.getElementById(e.current))), !m(s)) return;
      const p = ie(m(s)), N = p.includes(d.animationName) || p === "none";
      d.target === m(s) && N && u("ANIMATION_END");
    }
    function f(d) {
      m(s) || S(s, A(document.getElementById(e.current))), m(s) && d.target === m(s) && S(r, A(ie(m(s))));
    }
    x(() => a.current, () => {
      if (m(s) || S(s, A(document.getElementById(e.current))), !m(s)) return;
      const d = ie(m(s));
      S(r, A(a.current === "mounted" ? d : "none"));
    }), x(() => m(s), (d) => {
      if (d) return S(n, A(getComputedStyle(d))), z(_(d, "animationstart", f), _(d, "animationcancel", c), _(d, "animationend", c));
    });
    const l = ee(() => [
      "mounted",
      "unmountSuspended"
    ].includes(a.current));
    return {
      get current() {
        return m(l);
      }
    };
  }
  function ie(t) {
    return t && getComputedStyle(t).animationName || "none";
  }
  xi = function(t, e) {
    K(e, true);
    const n = ir(v.with(() => e.present), v.with(() => e.id));
    var r = F(), i = P(r);
    {
      var s = (o) => {
        var a = F(), u = P(a);
        H(u, () => e.presence ?? G, () => ({
          present: n
        })), L(o, a);
      };
      nt(i, (o) => {
        (e.forceMount || e.present || n.current) && o(s);
      });
    }
    L(t, r), V();
  };
  function sr(t, e) {
    var n = F(), r = P(n);
    Qt(r, () => e.children, (i) => {
      var s = F(), o = P(s);
      H(o, () => e.children ?? G), L(i, s);
    }), L(t, n);
  }
  Ri = function(t, e) {
    K(e, true);
    let n = T(e, "to", 3, "body");
    const r = jt();
    let i = ee(s);
    function s() {
      if (!de || e.disabled) return null;
      let l = null;
      return typeof n() == "string" ? l = document.querySelector(n()) : (n() instanceof HTMLElement || n() instanceof DocumentFragment) && (l = n()), l;
    }
    let o;
    function a() {
      o && (qt(o), o = null);
    }
    x([
      () => m(i),
      () => e.disabled
    ], ([l, d]) => {
      if (!l || d) {
        a();
        return;
      }
      return o = zt(sr, {
        target: l,
        props: {
          children: e.children
        },
        context: r
      }), () => {
        a();
      };
    });
    var u = F(), c = P(u);
    {
      var f = (l) => {
        var d = F(), p = P(d);
        H(p, () => e.children ?? G), L(l, d);
      };
      nt(c, (l) => {
        e.disabled && l(f);
      });
    }
    L(t, u), V();
  };
  lt = function(t, e, n, r) {
    const i = Array.isArray(e) ? e : [
      e
    ];
    return i.forEach((s) => t.addEventListener(s, n, r)), () => {
      i.forEach((s) => t.removeEventListener(s, n, r));
    };
  };
  class ft {
    eventName;
    options;
    constructor(e, n = {
      bubbles: true,
      cancelable: true
    }) {
      this.eventName = e, this.options = n;
    }
    createEvent(e) {
      return new CustomEvent(this.eventName, {
        ...this.options,
        detail: e
      });
    }
    dispatch(e, n) {
      const r = this.createEvent(n);
      return e.dispatchEvent(r), r;
    }
    listen(e, n, r) {
      const i = (s) => {
        n(s);
      };
      return _(e, this.eventName, i, r);
    }
  }
  function ze(t, e = 500) {
    let n = null;
    const r = (...i) => {
      n !== null && clearTimeout(n), n = setTimeout(() => {
        t(...i);
      }, e);
    };
    return r.destroy = () => {
      n !== null && (clearTimeout(n), n = null);
    }, r;
  }
  function Le(t, e) {
    return t === e || t.contains(e);
  }
  function dt(t) {
    return t?.ownerDocument ?? document;
  }
  function or(t, e) {
    const { clientX: n, clientY: r } = t, i = e.getBoundingClientRect();
    return n < i.left || n > i.right || r < i.top || r > i.bottom;
  }
  globalThis.bitsDismissableLayers ??= /* @__PURE__ */ new Map();
  class ar {
    opts;
    #t;
    #e;
    #n = {
      pointerdown: false
    };
    #r = false;
    #i = false;
    node = v(null);
    #o = void 0;
    #u;
    #c = k(null);
    get currNode() {
      return m(this.#c);
    }
    set currNode(e) {
      S(this.#c, A(e));
    }
    #s = R;
    constructor(e) {
      this.opts = e, xe({
        id: e.id,
        ref: this.node,
        deps: () => e.enabled.current,
        onRefChange: (i) => {
          this.currNode = i;
        }
      }), this.#e = e.interactOutsideBehavior, this.#t = e.onInteractOutside, this.#u = e.onFocusOutside, W(() => {
        this.#o = dt(this.currNode);
      });
      let n = R;
      const r = () => {
        this.#l(), globalThis.bitsDismissableLayers.delete(this), this.#a.destroy(), n();
      };
      x([
        () => this.opts.enabled.current,
        () => this.currNode
      ], ([i, s]) => {
        if (!(!i || !s)) return Re(1, () => {
          this.currNode && (globalThis.bitsDismissableLayers.set(this, this.#e), n(), n = this.#d());
        }), r;
      }), ut(() => {
        this.#l.destroy(), globalThis.bitsDismissableLayers.delete(this), this.#a.destroy(), this.#s(), n();
      });
    }
    #f = (e) => {
      e.defaultPrevented || this.currNode && fe(() => {
        !this.currNode || this.#g(e.target) || e.target && !this.#i && this.#u.current?.(e);
      });
    };
    #d() {
      return z(_(this.#o, "pointerdown", z(this.#v, this.#b), {
        capture: true
      }), _(this.#o, "pointerdown", z(this.#m, this.#a)), _(this.#o, "focusin", this.#f));
    }
    #h = (e) => {
      let n = e;
      n.defaultPrevented && (n = qe(e)), this.#t.current(e);
    };
    #a = ze((e) => {
      if (!this.currNode) {
        this.#s();
        return;
      }
      const n = this.opts.isValidEvent.current(e, this.currNode) || fr(e, this.currNode);
      if (!this.#r || this.#p() || !n) {
        this.#s();
        return;
      }
      let r = e;
      if (r.defaultPrevented && (r = qe(r)), this.#e.current !== "close" && this.#e.current !== "defer-otherwise-close") {
        this.#s();
        return;
      }
      e.pointerType === "touch" ? (this.#s(), this.#s = lt(this.#o, "click", this.#h, {
        once: true
      })) : this.#t.current(r);
    }, 10);
    #v = (e) => {
      this.#n[e.type] = true;
    };
    #m = (e) => {
      this.#n[e.type] = false;
    };
    #b = () => {
      this.node.current && (this.#r = lr(this.node.current));
    };
    #g = (e) => this.node.current ? Le(this.node.current, e) : false;
    #l = ze(() => {
      for (const e in this.#n) this.#n[e] = false;
      this.#r = false;
    }, 20);
    #p() {
      return Object.values(this.#n).some(Boolean);
    }
    #y = () => {
      this.#i = true;
    };
    #E = () => {
      this.#i = false;
    };
    props = {
      onfocuscapture: this.#y,
      onblurcapture: this.#E
    };
  }
  function ur(t) {
    return new ar(t);
  }
  function cr(t) {
    return t.findLast(([e, { current: n }]) => n === "close" || n === "ignore");
  }
  function lr(t) {
    const e = [
      ...globalThis.bitsDismissableLayers
    ], n = cr(e);
    if (n) return n[0].node.current === t;
    const [r] = e[0];
    return r.node.current === t;
  }
  function fr(t, e) {
    if ("button" in t && t.button > 0) return false;
    const n = t.target;
    return er(n) ? dt(n).documentElement.contains(n) && !Le(e, n) && or(t, e) : false;
  }
  function qe(t) {
    const e = t.currentTarget, n = t.target;
    let r;
    t instanceof PointerEvent ? r = new PointerEvent(t.type, t) : r = new PointerEvent("pointerdown", t);
    let i = false;
    return new Proxy(r, {
      get: (o, a) => a === "currentTarget" ? e : a === "target" ? n : a === "preventDefault" ? () => {
        i = true, typeof o.preventDefault == "function" && o.preventDefault();
      } : a === "defaultPrevented" ? i : a in o ? o[a] : t[a]
    });
  }
  Pi = function(t, e) {
    K(e, true);
    let n = T(e, "interactOutsideBehavior", 3, "close"), r = T(e, "onInteractOutside", 3, R), i = T(e, "onFocusOutside", 3, R), s = T(e, "isValidEvent", 3, () => false);
    const o = ur({
      id: v.with(() => e.id),
      interactOutsideBehavior: v.with(() => n()),
      onInteractOutside: v.with(() => r()),
      enabled: v.with(() => e.enabled),
      onFocusOutside: v.with(() => i()),
      isValidEvent: v.with(() => s())
    });
    var a = F(), u = P(a);
    H(u, () => e.children ?? G, () => ({
      props: o.props
    })), L(t, a), V();
  };
  globalThis.bitsEscapeLayers ??= /* @__PURE__ */ new Map();
  class dr {
    opts;
    constructor(e) {
      this.opts = e;
      let n = R;
      x(() => e.enabled.current, (r) => (r && (globalThis.bitsEscapeLayers.set(this, e.escapeKeydownBehavior), n = this.#t()), () => {
        n(), globalThis.bitsEscapeLayers.delete(this);
      }));
    }
    #t = () => _(document, "keydown", this.#e, {
      passive: false
    });
    #e = (e) => {
      if (e.key !== zn || !vr(this)) return;
      const n = new KeyboardEvent(e.type, e);
      e.preventDefault();
      const r = this.opts.escapeKeydownBehavior.current;
      r !== "close" && r !== "defer-otherwise-close" || this.opts.onEscapeKeydown.current(n);
    };
  }
  function hr(t) {
    return new dr(t);
  }
  function vr(t) {
    const e = [
      ...globalThis.bitsEscapeLayers
    ], n = e.findLast(([i, { current: s }]) => s === "close" || s === "ignore");
    if (n) return n[0] === t;
    const [r] = e[0];
    return r === t;
  }
  Fi = function(t, e) {
    K(e, true);
    let n = T(e, "escapeKeydownBehavior", 3, "close"), r = T(e, "onEscapeKeydown", 3, R);
    hr({
      escapeKeydownBehavior: v.with(() => n()),
      onEscapeKeydown: v.with(() => r()),
      enabled: v.with(() => e.enabled)
    });
    var i = F(), s = P(i);
    H(s, () => e.children ?? G), L(t, i), V();
  };
  const B = v([]);
  function mr() {
    return {
      add(t) {
        const e = B.current[0];
        e && t.id !== e.id && e.pause(), B.current = Xe(B.current, t), B.current.unshift(t);
      },
      remove(t) {
        B.current = Xe(B.current, t), B.current[0]?.resume();
      },
      get current() {
        return B.current;
      }
    };
  }
  function br() {
    let t = k(false), e = k(false);
    return {
      id: ct(),
      get paused() {
        return m(t);
      },
      get isHandlingFocus() {
        return m(e);
      },
      set isHandlingFocus(n) {
        S(e, A(n));
      },
      pause() {
        S(t, true);
      },
      resume() {
        S(t, false);
      }
    };
  }
  function Xe(t, e) {
    return [
      ...t
    ].filter((n) => n.id !== e.id);
  }
  function gr(t) {
    return t.filter((e) => e.tagName !== "A");
  }
  function j(t, { select: e = false } = {}) {
    if (!(t && t.focus) || document.activeElement === t) return;
    const n = document.activeElement;
    t.focus({
      preventScroll: true
    }), t !== n && tr(t) && e && t.select();
  }
  function pr(t, { select: e = false } = {}) {
    const n = document.activeElement;
    for (const r of t) if (j(r, {
      select: e
    }), document.activeElement !== n) return true;
  }
  function Ye(t, e) {
    for (const n of t) if (!nr(n, e)) return n;
  }
  function ht(t) {
    const e = [], n = document.createTreeWalker(t, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (r) => {
        const i = r.tagName === "INPUT" && r.type === "hidden";
        return r.disabled || r.hidden || i ? NodeFilter.FILTER_SKIP : r.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    for (; n.nextNode(); ) e.push(n.currentNode);
    return e;
  }
  function yr(t) {
    const e = ht(t), n = Ye(e, t), r = Ye(e.reverse(), t);
    return [
      n,
      r
    ];
  }
  let vt, ae, mt, q, ue, ce, Er, bt, gt, pt, wr, Sr, Et, Tr, Nr, Ar, Ir, _r, Cr, Or, Ze, xr, Rr, le, Ae, Pr, Fr, Dr;
  vt = [
    "input:not([inert])",
    "select:not([inert])",
    "textarea:not([inert])",
    "a[href]:not([inert])",
    "button:not([inert])",
    "[tabindex]:not(slot):not([inert])",
    "audio[controls]:not([inert])",
    "video[controls]:not([inert])",
    '[contenteditable]:not([contenteditable="false"]):not([inert])',
    "details>summary:first-of-type:not([inert])",
    "details:not([inert])"
  ];
  ae = vt.join(",");
  mt = typeof Element > "u";
  q = mt ? function() {
  } : Element.prototype.matches || Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
  ue = !mt && Element.prototype.getRootNode ? function(t) {
    var e;
    return t == null || (e = t.getRootNode) === null || e === void 0 ? void 0 : e.call(t);
  } : function(t) {
    return t?.ownerDocument;
  };
  ce = function t(e, n) {
    var r;
    n === void 0 && (n = true);
    var i = e == null || (r = e.getAttribute) === null || r === void 0 ? void 0 : r.call(e, "inert"), s = i === "" || i === "true", o = s || n && e && t(e.parentNode);
    return o;
  };
  Er = function(e) {
    var n, r = e == null || (n = e.getAttribute) === null || n === void 0 ? void 0 : n.call(e, "contenteditable");
    return r === "" || r === "true";
  };
  bt = function(e, n, r) {
    if (ce(e)) return [];
    var i = Array.prototype.slice.apply(e.querySelectorAll(ae));
    return n && q.call(e, ae) && i.unshift(e), i = i.filter(r), i;
  };
  gt = function t(e, n, r) {
    for (var i = [], s = Array.from(e); s.length; ) {
      var o = s.shift();
      if (!ce(o, false)) if (o.tagName === "SLOT") {
        var a = o.assignedElements(), u = a.length ? a : o.children, c = t(u, true, r);
        r.flatten ? i.push.apply(i, c) : i.push({
          scopeParent: o,
          candidates: c
        });
      } else {
        var f = q.call(o, ae);
        f && r.filter(o) && (n || !e.includes(o)) && i.push(o);
        var l = o.shadowRoot || typeof r.getShadowRoot == "function" && r.getShadowRoot(o), d = !ce(l, false) && (!r.shadowRootFilter || r.shadowRootFilter(o));
        if (l && d) {
          var p = t(l === true ? o.children : l.children, true, r);
          r.flatten ? i.push.apply(i, p) : i.push({
            scopeParent: o,
            candidates: p
          });
        } else s.unshift.apply(s, o.children);
      }
    }
    return i;
  };
  pt = function(e) {
    return !isNaN(parseInt(e.getAttribute("tabindex"), 10));
  };
  yt = function(e) {
    if (!e) throw new Error("No node provided");
    return e.tabIndex < 0 && (/^(AUDIO|VIDEO|DETAILS)$/.test(e.tagName) || Er(e)) && !pt(e) ? 0 : e.tabIndex;
  };
  wr = function(e, n) {
    var r = yt(e);
    return r < 0 && n && !pt(e) ? 0 : r;
  };
  Sr = function(e, n) {
    return e.tabIndex === n.tabIndex ? e.documentOrder - n.documentOrder : e.tabIndex - n.tabIndex;
  };
  Et = function(e) {
    return e.tagName === "INPUT";
  };
  Tr = function(e) {
    return Et(e) && e.type === "hidden";
  };
  Nr = function(e) {
    var n = e.tagName === "DETAILS" && Array.prototype.slice.apply(e.children).some(function(r) {
      return r.tagName === "SUMMARY";
    });
    return n;
  };
  Ar = function(e, n) {
    for (var r = 0; r < e.length; r++) if (e[r].checked && e[r].form === n) return e[r];
  };
  Ir = function(e) {
    if (!e.name) return true;
    var n = e.form || ue(e), r = function(a) {
      return n.querySelectorAll('input[type="radio"][name="' + a + '"]');
    }, i;
    if (typeof window < "u" && typeof window.CSS < "u" && typeof window.CSS.escape == "function") i = r(window.CSS.escape(e.name));
    else try {
      i = r(e.name);
    } catch (o) {
      return console.error("Looks like you have a radio button with a name attribute containing invalid CSS selector characters and need the CSS.escape polyfill: %s", o.message), false;
    }
    var s = Ar(i, e.form);
    return !s || s === e;
  };
  _r = function(e) {
    return Et(e) && e.type === "radio";
  };
  Cr = function(e) {
    return _r(e) && !Ir(e);
  };
  Or = function(e) {
    var n, r = e && ue(e), i = (n = r) === null || n === void 0 ? void 0 : n.host, s = false;
    if (r && r !== e) {
      var o, a, u;
      for (s = !!((o = i) !== null && o !== void 0 && (a = o.ownerDocument) !== null && a !== void 0 && a.contains(i) || e != null && (u = e.ownerDocument) !== null && u !== void 0 && u.contains(e)); !s && i; ) {
        var c, f, l;
        r = ue(i), i = (c = r) === null || c === void 0 ? void 0 : c.host, s = !!((f = i) !== null && f !== void 0 && (l = f.ownerDocument) !== null && l !== void 0 && l.contains(i));
      }
    }
    return s;
  };
  Ze = function(e) {
    var n = e.getBoundingClientRect(), r = n.width, i = n.height;
    return r === 0 && i === 0;
  };
  xr = function(e, n) {
    var r = n.displayCheck, i = n.getShadowRoot;
    if (getComputedStyle(e).visibility === "hidden") return true;
    var s = q.call(e, "details>summary:first-of-type"), o = s ? e.parentElement : e;
    if (q.call(o, "details:not([open]) *")) return true;
    if (!r || r === "full" || r === "legacy-full") {
      if (typeof i == "function") {
        for (var a = e; e; ) {
          var u = e.parentElement, c = ue(e);
          if (u && !u.shadowRoot && i(u) === true) return Ze(e);
          e.assignedSlot ? e = e.assignedSlot : !u && c !== e.ownerDocument ? e = c.host : e = u;
        }
        e = a;
      }
      if (Or(e)) return !e.getClientRects().length;
      if (r !== "legacy-full") return true;
    } else if (r === "non-zero-area") return Ze(e);
    return false;
  };
  Rr = function(e) {
    if (/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.tagName)) for (var n = e.parentElement; n; ) {
      if (n.tagName === "FIELDSET" && n.disabled) {
        for (var r = 0; r < n.children.length; r++) {
          var i = n.children.item(r);
          if (i.tagName === "LEGEND") return q.call(n, "fieldset[disabled] *") ? true : !i.contains(e);
        }
        return true;
      }
      n = n.parentElement;
    }
    return false;
  };
  le = function(e, n) {
    return !(n.disabled || ce(n) || Tr(n) || xr(n, e) || Nr(n) || Rr(n));
  };
  Ae = function(e, n) {
    return !(Cr(n) || yt(n) < 0 || !le(e, n));
  };
  Pr = function(e) {
    var n = parseInt(e.getAttribute("tabindex"), 10);
    return !!(isNaN(n) || n >= 0);
  };
  Fr = function t(e) {
    var n = [], r = [];
    return e.forEach(function(i, s) {
      var o = !!i.scopeParent, a = o ? i.scopeParent : i, u = wr(a, o), c = o ? t(i.candidates) : a;
      u === 0 ? o ? n.push.apply(n, c) : n.push(a) : r.push({
        documentOrder: s,
        tabIndex: u,
        item: i,
        isScope: o,
        content: c
      });
    }), r.sort(Sr).reduce(function(i, s) {
      return s.isScope ? i.push.apply(i, s.content) : i.push(s.content), i;
    }, []).concat(n);
  };
  Li = function(e, n) {
    n = n || {};
    var r;
    return n.getShadowRoot ? r = gt([
      e
    ], n.includeContainer, {
      filter: Ae.bind(null, n),
      flatten: false,
      getShadowRoot: n.getShadowRoot,
      shadowRootFilter: Pr
    }) : r = bt(e, n.includeContainer, Ae.bind(null, n)), Fr(r);
  };
  Di = function(e, n) {
    n = n || {};
    var r;
    return n.getShadowRoot ? r = gt([
      e
    ], n.includeContainer, {
      filter: le.bind(null, n),
      flatten: true,
      getShadowRoot: n.getShadowRoot
    }) : r = bt(e, n.includeContainer, le.bind(null, n)), r;
  };
  Lr = function(e, n) {
    if (n = n || {}, !e) throw new Error("No node provided");
    return q.call(e, ae) === false ? false : Ae(n, e);
  };
  Dr = vt.concat("iframe").join(",");
  Mi = function(e, n) {
    if (n = n || {}, !e) throw new Error("No node provided");
    return q.call(e, Dr) === false ? false : le(n, e);
  };
  const Mr = new ft("focusScope.autoFocusOnMount", {
    bubbles: false,
    cancelable: true
  }), kr = new ft("focusScope.autoFocusOnDestroy", {
    bubbles: false,
    cancelable: true
  }), Br = new Gn("FocusScope");
  function jr({ id: t, loop: e, enabled: n, onOpenAutoFocus: r, onCloseAutoFocus: i, forceMount: s }) {
    const o = mr(), a = br(), u = v(null), c = Br.getOr({
      ignoreCloseAutoFocus: false
    });
    let f = null;
    xe({
      id: t,
      ref: u,
      deps: () => n.current
    });
    function l(h) {
      if (!(a.paused || !u.current || a.isHandlingFocus)) {
        a.isHandlingFocus = true;
        try {
          const g = h.target;
          if (!Ne(g)) return;
          const w = u.current.contains(g);
          if (h.type === "focusin") if (w) f = g;
          else {
            if (c.ignoreCloseAutoFocus) return;
            j(f, {
              select: true
            });
          }
          else h.type === "focusout" && !w && !c.ignoreCloseAutoFocus && j(f, {
            select: true
          });
        } finally {
          a.isHandlingFocus = false;
        }
      }
    }
    function d(h) {
      !u.current?.contains(f) && u.current && j(u.current);
    }
    x([
      () => u.current,
      () => n.current
    ], ([h, g]) => {
      if (!h || !g) return;
      const w = z(_(document, "focusin", l), _(document, "focusout", l)), I = new MutationObserver(d);
      return I.observe(h, {
        childList: true,
        subtree: true
      }), () => {
        w(), I.disconnect();
      };
    }), x([
      () => s.current,
      () => u.current
    ], ([h, g]) => {
      if (h) return;
      const w = document.activeElement;
      return p(g, w), () => {
        g && N(w);
      };
    }), x([
      () => s.current,
      () => u.current,
      () => n.current
    ], ([h, g]) => {
      if (!h) return;
      const w = document.activeElement;
      return p(g, w), () => {
        g && N(w);
      };
    });
    function p(h, g) {
      if (h || (h = document.getElementById(t.current)), !h || !n.current) return;
      if (o.add(a), !h.contains(g)) {
        const I = Mr.createEvent();
        r.current(I), I.defaultPrevented || fe(() => {
          h && (pr(gr(ht(h)), {
            select: true
          }), document.activeElement === g && j(h));
        });
      }
    }
    function N(h) {
      const g = kr.createEvent();
      i.current(g);
      const w = c.ignoreCloseAutoFocus;
      Re(0, () => {
        !g.defaultPrevented && h && !w && j(Lr(h) ? h : document.body, {
          select: true
        }), o.remove(a);
      });
    }
    function y(h) {
      if (!n.current || !e.current && !n.current || a.paused) return;
      const g = h.key === Xn && !h.ctrlKey && !h.altKey && !h.metaKey, w = document.activeElement;
      if (!(g && w)) return;
      const I = u.current;
      if (!I) return;
      const [X, Y] = yr(I);
      X && Y ? !h.shiftKey && w === Y ? (h.preventDefault(), e.current && j(X, {
        select: true
      })) : h.shiftKey && w === X && (h.preventDefault(), e.current && j(Y, {
        select: true
      })) : w === I && h.preventDefault();
    }
    const C = ee(() => ({
      id: t.current,
      tabindex: -1,
      onkeydown: y
    }));
    return {
      get props() {
        return m(C);
      }
    };
  }
  ki = function(t, e) {
    K(e, true);
    let n = T(e, "trapFocus", 3, false), r = T(e, "loop", 3, false), i = T(e, "onCloseAutoFocus", 3, R), s = T(e, "onOpenAutoFocus", 3, R), o = T(e, "forceMount", 3, false);
    const a = jr({
      enabled: v.with(() => n()),
      loop: v.with(() => r()),
      onCloseAutoFocus: v.with(() => i()),
      onOpenAutoFocus: v.with(() => s()),
      id: v.with(() => e.id),
      forceMount: v.with(() => o())
    });
    var u = F(), c = P(u);
    H(c, () => e.focusScope ?? G, () => ({
      props: a.props
    })), L(t, u), V();
  };
  globalThis.bitsTextSelectionLayers ??= /* @__PURE__ */ new Map();
  class Ur {
    opts;
    #t = R;
    #e = v(null);
    constructor(e) {
      this.opts = e, xe({
        id: e.id,
        ref: this.#e,
        deps: () => this.opts.enabled.current
      });
      let n = R;
      x(() => this.opts.enabled.current, (r) => (r && (globalThis.bitsTextSelectionLayers.set(this, this.opts.enabled), n(), n = this.#n()), () => {
        n(), this.#i(), globalThis.bitsTextSelectionLayers.delete(this);
      }));
    }
    #n() {
      return z(_(document, "pointerdown", this.#r), _(document, "pointerup", it(this.#i, this.opts.onPointerUp.current)));
    }
    #r = (e) => {
      const n = this.#e.current, r = e.target;
      !Ne(n) || !Ne(r) || !this.opts.enabled.current || !Vr(this) || !Le(n, r) || (this.opts.onPointerDown.current(e), !e.defaultPrevented && (this.#t = Kr(n)));
    };
    #i = () => {
      this.#t(), this.#t = R;
    };
  }
  function Wr(t) {
    return new Ur(t);
  }
  const Je = (t) => t.style.userSelect || t.style.webkitUserSelect;
  function Kr(t) {
    const e = document.body, n = Je(e), r = Je(t);
    return se(e, "none"), se(t, "text"), () => {
      se(e, n), se(t, r);
    };
  }
  function se(t, e) {
    t.style.userSelect = e, t.style.webkitUserSelect = e;
  }
  function Vr(t) {
    const e = [
      ...globalThis.bitsTextSelectionLayers
    ];
    if (!e.length) return false;
    const n = e.at(-1);
    return n ? n[0] === t : false;
  }
  Bi = function(t, e) {
    K(e, true);
    let n = T(e, "preventOverflowTextSelection", 3, true), r = T(e, "onPointerDown", 3, R), i = T(e, "onPointerUp", 3, R);
    Wr({
      id: v.with(() => e.id),
      preventOverflowTextSelection: v.with(() => n()),
      onPointerDown: v.with(() => r()),
      onPointerUp: v.with(() => i()),
      enabled: v.with(() => e.enabled)
    });
    var s = F(), o = P(s);
    H(o, () => e.children ?? G), L(t, s), V();
  };
  function Gr(t) {
    let e = 0, n = k(void 0), r;
    function i() {
      e -= 1, r && e <= 0 && (r(), S(n, void 0), r = void 0);
    }
    return (...s) => (e += 1, m(n) === void 0 && (r = Ut(() => {
      S(n, A(t(...s)));
    })), W(() => () => {
      i();
    }), m(n));
  }
  const Hr = Gr(() => {
    const t = new dn(), e = ee(() => {
      for (const s of t.values()) if (s) return true;
      return false;
    });
    let n = k(null), r = null;
    function i() {
      de && (document.body.setAttribute("style", m(n) ?? ""), document.body.style.removeProperty("--scrollbar-width"), He && r?.());
    }
    return W(() => {
      const s = m(e);
      return Ie(() => {
        if (!s) return;
        S(n, A(document.body.getAttribute("style")));
        const o = getComputedStyle(document.body), a = window.innerWidth - document.documentElement.clientWidth, c = {
          padding: Number.parseInt(o.paddingRight ?? "0", 10) + a,
          margin: Number.parseInt(o.marginRight ?? "0", 10)
        };
        a > 0 && (document.body.style.paddingRight = `${c.padding}px`, document.body.style.marginRight = `${c.margin}px`, document.body.style.setProperty("--scrollbar-width", `${a}px`), document.body.style.overflow = "hidden"), He && (r = lt(document, "touchmove", (f) => {
          f.target === document.documentElement && (f.touches.length > 1 || f.preventDefault());
        }, {
          passive: false
        })), fe(() => {
          document.body.style.pointerEvents = "none", document.body.style.overflow = "hidden";
        });
      });
    }), W(() => () => {
      r?.();
    }), {
      get map() {
        return t;
      },
      resetBodyStyle: i
    };
  });
  function zr(t, e = () => null) {
    const n = ct(), r = Hr();
    if (!r) return;
    const i = ee(e);
    r.map.set(n, t ?? false);
    const s = v.with(() => r.map.get(n) ?? false, (o) => r.map.set(n, o));
    return W(() => () => {
      r.map.delete(n), !qr(r.map) && (m(i) === null ? requestAnimationFrame(() => r.resetBodyStyle()) : Re(m(i), () => r.resetBodyStyle()));
    }), s;
  }
  function qr(t) {
    for (const [e, n] of t) if (n) return true;
    return false;
  }
  ji = function(t, e) {
    K(e, true);
    let n = T(e, "preventScroll", 3, true), r = T(e, "restoreScrollDelay", 3, null);
    zr(n(), () => r()), V();
  };
  Ui = function(t, e) {
    K(e, true);
    let n = T(e, "disabled", 3, false), r = T(e, "ref", 15), i = Xt(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "href",
      "type",
      "children",
      "disabled",
      "ref"
    ]);
    var s = F(), o = P(s);
    $t(o, () => e.href ? "a" : "button", false, (a, u) => {
      Jt(a, (d) => r(d), () => r());
      let c;
      Wt(() => c = Gt(a, c, {
        "data-button-root": true,
        type: e.href ? void 0 : e.type,
        href: e.href && !n() ? e.href : void 0,
        disabled: e.href ? void 0 : n(),
        "aria-disabled": e.href ? n() : void 0,
        role: e.href && n() ? "link" : void 0,
        tabindex: e.href && n() ? -1 : 0,
        ...i
      }));
      var f = F(), l = P(f);
      H(l, () => e.children ?? G), L(u, f);
    }), L(t, s), V();
  };
});
export {
  rr as $,
  Te as A,
  Ui as B,
  Gn as C,
  Pi as D,
  Ni as E,
  ki as F,
  Xn as G,
  Ii as H,
  qn as I,
  Ai as J,
  Hn as K,
  ut as L,
  Ti as M,
  Vn as N,
  He as O,
  Ri as P,
  Bn as Q,
  li as R,
  _i as S,
  Bi as T,
  re as U,
  Ci as V,
  ot as W,
  bi as X,
  er as Y,
  z as Z,
  lt as _,
  __tla,
  xe as a,
  Li as a0,
  Di as a1,
  Lr as a2,
  yt as a3,
  Mi as a4,
  $t as a5,
  Qt as a6,
  ai as b,
  Si as c,
  wi as d,
  mi as e,
  Ei as f,
  pi as g,
  Oi as h,
  ct as i,
  v as j,
  yi as k,
  gi as l,
  fi as m,
  R as n,
  dn as o,
  ui as p,
  di as q,
  hi as r,
  vi as s,
  fe as t,
  ci as u,
  xi as v,
  x as w,
  Fi as x,
  ji as y,
  Se as z
};
