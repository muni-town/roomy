import "./NZTpNUN0.js";
import { d as Y, u as at, g as w, e as T, _ as We, a0 as Ve, p as $, f as k, a as tt, c as pt, m as wt, r as xt, t as ct, b as K, s as ht, A as Ne } from "./BMAj9zKA.js";
import { c as V, a as _, t as vt, n as Qt } from "./pDBoOQRd.js";
import { i as lt } from "./BA1UOs1h.js";
import { b as Tt, r as le, s as P } from "./DjDC-EQm.js";
import { Q as He, C as Jt, a as At, i as Dt, j as O, m as Ot, R as ze, b as Ke, U as Ye, V as Ue, W as Xe, w as ue, F as qe, y as de, x as je, D as Ze, T as Qe, v as Je, __tla as __tla_0 } from "./BOaKtN8S.js";
import { p as b, r as gt, s as Lt } from "./D_-9kNr4.js";
import { s as J } from "./k4NpJaFV.js";
import { o as Ge } from "./BqahWDdA.js";
import { p as M } from "./Baj-A2iI.js";
import { c as Yt } from "./BUHZJKy3.js";
import { k as $e } from "./BSdt-dIf.js";
import "./69_IOA4Y.js";
import { i as tn } from "./CrW2qrX9.js";
import { d as en, g as Xt, w as Se } from "./Dxu-ImQV.js";
let mi, Mt, di, li, hi, gi, fi, Tr, xe, Nr, vi, Dr, wn, yn, xn, ui, Mr, pi, wi, Z, yi;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  function nn(e) {
    return typeof e == "function";
  }
  function rn(e) {
    return nn(e) ? e() : e;
  }
  class on {
    #t = Y(M({
      width: 0,
      height: 0
    }));
    constructor(t, n = {
      box: "border-box"
    }) {
      const r = n.window ?? He;
      this.#t.v = M({
        width: n.initialSize?.width ?? 0,
        height: n.initialSize?.height ?? 0
      }), at(() => {
        if (!r) return;
        const i = rn(t);
        if (!i) return;
        const o = new r.ResizeObserver((s) => {
          for (const c of s) {
            const a = n.box === "content-box" ? c.contentBoxSize : c.borderBoxSize, d = Array.isArray(a) ? a : [
              a
            ];
            w(this.#t).width = d.reduce((f, l) => Math.max(f, l.inlineSize), 0), w(this.#t).height = d.reduce((f, l) => Math.max(f, l.blockSize), 0);
          }
        });
        return o.observe(i), () => {
          o.disconnect();
        };
      });
    }
    get current() {
      return w(this.#t);
    }
    get width() {
      return w(this.#t).width;
    }
    get height() {
      return w(this.#t).height;
    }
  }
  const sn = "data-avatar-root", an = "data-avatar-image", cn = "data-avatar-fallback";
  class ln {
    opts;
    constructor(t) {
      this.opts = t, this.loadImage = this.loadImage.bind(this), At(t);
    }
    loadImage(t, n, r) {
      if (this.opts.loadingStatus.current === "loaded") return;
      let i;
      const o = new Image();
      return o.src = t, n !== void 0 && (o.crossOrigin = n), r && (o.referrerPolicy = r), this.opts.loadingStatus.current = "loading", o.onload = () => {
        i = window.setTimeout(() => {
          this.opts.loadingStatus.current = "loaded";
        }, this.opts.delayMs.current);
      }, o.onerror = () => {
        this.opts.loadingStatus.current = "error";
      }, () => {
        window.clearTimeout(i);
      };
    }
    #t = T(() => ({
      id: this.opts.id.current,
      [sn]: "",
      "data-status": this.opts.loadingStatus.current
    }));
    get props() {
      return w(this.#t);
    }
  }
  class un {
    opts;
    root;
    constructor(t, n) {
      this.opts = t, this.root = n, At(t), We(() => {
        if (!this.opts.src.current) {
          this.root.opts.loadingStatus.current = "error";
          return;
        }
        this.opts.crossOrigin.current, Ve(() => this.root.loadImage(this.opts.src.current ?? "", this.opts.crossOrigin.current, this.opts.referrerPolicy.current));
      });
    }
    #t = T(() => ({
      id: this.opts.id.current,
      style: {
        display: this.root.opts.loadingStatus.current === "loaded" ? "block" : "none"
      },
      "data-status": this.root.opts.loadingStatus.current,
      [an]: "",
      src: this.opts.src.current,
      crossorigin: this.opts.crossOrigin.current,
      referrerpolicy: this.opts.referrerPolicy.current
    }));
    get props() {
      return w(this.#t);
    }
  }
  class dn {
    opts;
    root;
    constructor(t, n) {
      this.opts = t, this.root = n, At(t);
    }
    #t = T(() => ({
      style: {
        display: this.root.opts.loadingStatus.current === "loaded" ? "none" : void 0
      },
      "data-status": this.root.opts.loadingStatus.current,
      [cn]: ""
    }));
    get props() {
      return w(this.#t);
    }
  }
  const Gt = new Jt("Avatar.Root");
  function fn(e) {
    return Gt.set(new ln(e));
  }
  function gn(e) {
    return new un(e, Gt.get());
  }
  function hn(e) {
    return new dn(e, Gt.get());
  }
  var mn = vt("<div><!></div>");
  wn = function(e, t) {
    $(t, true);
    let n = b(t, "delayMs", 3, 0), r = b(t, "loadingStatus", 15, "loading"), i = b(t, "id", 19, Dt), o = b(t, "ref", 15, null), s = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "delayMs",
      "loadingStatus",
      "onLoadingStatusChange",
      "child",
      "children",
      "id",
      "ref"
    ]);
    const c = fn({
      delayMs: O.with(() => n()),
      loadingStatus: O.with(() => r(), (u) => {
        r() !== u && (r(u), t.onLoadingStatusChange?.(u));
      }),
      id: O.with(() => i()),
      ref: O.with(() => o(), (u) => o(u))
    }), a = T(() => Ot(s, c.props));
    var d = V(), f = k(d);
    {
      var l = (u) => {
        var g = V(), m = k(g);
        J(m, () => t.child, () => ({
          props: w(a)
        })), _(u, g);
      }, h = (u) => {
        var g = mn();
        let m;
        var v = pt(g);
        J(v, () => t.children ?? wt), xt(g), ct(() => m = Tt(g, m, {
          ...w(a)
        })), _(u, g);
      };
      lt(f, (u) => {
        t.child ? u(l) : u(h, false);
      });
    }
    _(e, d), tt();
  };
  var vn = vt("<img>");
  yn = function(e, t) {
    $(t, true);
    let n = b(t, "id", 19, Dt), r = b(t, "ref", 15, null), i = b(t, "crossorigin", 3, void 0), o = b(t, "referrerpolicy", 3, void 0), s = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "src",
      "child",
      "id",
      "ref",
      "crossorigin",
      "referrerpolicy"
    ]);
    const c = gn({
      src: O.with(() => t.src),
      id: O.with(() => n()),
      ref: O.with(() => r(), (u) => r(u)),
      crossOrigin: O.with(() => i()),
      referrerPolicy: O.with(() => o())
    }), a = T(() => Ot(s, c.props));
    var d = V(), f = k(d);
    {
      var l = (u) => {
        var g = V(), m = k(g);
        J(m, () => t.child, () => ({
          props: w(a)
        })), _(u, g);
      }, h = (u) => {
        var g = vn();
        let m;
        ct(() => m = Tt(g, m, {
          ...w(a),
          src: t.src
        })), $e(g), _(u, g);
      };
      lt(f, (u) => {
        t.child ? u(l) : u(h, false);
      });
    }
    _(e, d), tt();
  };
  var pn = vt("<span><!></span>");
  xn = function(e, t) {
    $(t, true);
    let n = b(t, "id", 19, Dt), r = b(t, "ref", 15, null), i = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "children",
      "child",
      "id",
      "ref"
    ]);
    const o = hn({
      id: O.with(() => n()),
      ref: O.with(() => r(), (l) => r(l))
    }), s = T(() => Ot(i, o.props));
    var c = V(), a = k(c);
    {
      var d = (l) => {
        var h = V(), u = k(h);
        J(u, () => t.child, () => ({
          props: w(s)
        })), _(l, h);
      }, f = (l) => {
        var h = pn();
        let u;
        var g = pt(h);
        J(g, () => t.children ?? wt), xt(h), ct(() => u = Tt(h, u, {
          ...w(s)
        })), _(l, h);
      };
      lt(a, (l) => {
        t.child ? l(d) : l(f, false);
      });
    }
    _(e, c), tt();
  };
  var bn = vt("<input>"), An = vt("<input>");
  li = function(e, t) {
    $(t, true);
    let n = b(t, "value", 15), r = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "value"
    ]);
    const i = T(() => Ot(r, {
      "aria-hidden": "true",
      tabindex: -1,
      style: ze
    }));
    var o = V(), s = k(o);
    {
      var c = (d) => {
        var f = bn();
        le(f);
        let l;
        ct(() => l = Tt(f, l, {
          ...w(i),
          value: n()
        })), _(d, f);
      }, a = (d) => {
        var f = An();
        le(f);
        let l;
        ct(() => l = Tt(f, l, {
          ...w(i)
        })), Ke(f, n), _(d, f);
      };
      lt(s, (d) => {
        w(i).type === "checkbox" ? d(c) : d(a, false);
      });
    }
    _(e, o), tt();
  };
  const Sn = [
    "top",
    "right",
    "bottom",
    "left"
  ], ut = Math.min, N = Math.max, Wt = Math.round, kt = Math.floor, Q = (e) => ({
    x: e,
    y: e
  }), On = {
    left: "right",
    right: "left",
    bottom: "top",
    top: "bottom"
  }, Pn = {
    start: "end",
    end: "start"
  };
  function qt(e, t, n) {
    return N(e, ut(t, n));
  }
  function rt(e, t) {
    return typeof e == "function" ? e(t) : e;
  }
  function it(e) {
    return e.split("-")[0];
  }
  function Pt(e) {
    return e.split("-")[1];
  }
  function $t(e) {
    return e === "x" ? "y" : "x";
  }
  function te(e) {
    return e === "y" ? "height" : "width";
  }
  function dt(e) {
    return [
      "top",
      "bottom"
    ].includes(it(e)) ? "y" : "x";
  }
  function ee(e) {
    return $t(dt(e));
  }
  function Cn(e, t, n) {
    n === void 0 && (n = false);
    const r = Pt(e), i = ee(e), o = te(i);
    let s = i === "x" ? r === (n ? "end" : "start") ? "right" : "left" : r === "start" ? "bottom" : "top";
    return t.reference[o] > t.floating[o] && (s = Vt(s)), [
      s,
      Vt(s)
    ];
  }
  function Rn(e) {
    const t = Vt(e);
    return [
      jt(e),
      t,
      jt(t)
    ];
  }
  function jt(e) {
    return e.replace(/start|end/g, (t) => Pn[t]);
  }
  function Tn(e, t, n) {
    const r = [
      "left",
      "right"
    ], i = [
      "right",
      "left"
    ], o = [
      "top",
      "bottom"
    ], s = [
      "bottom",
      "top"
    ];
    switch (e) {
      case "top":
      case "bottom":
        return n ? t ? i : r : t ? r : i;
      case "left":
      case "right":
        return t ? o : s;
      default:
        return [];
    }
  }
  function Fn(e, t, n, r) {
    const i = Pt(e);
    let o = Tn(it(e), n === "start", r);
    return i && (o = o.map((s) => s + "-" + i), t && (o = o.concat(o.map(jt)))), o;
  }
  function Vt(e) {
    return e.replace(/left|right|bottom|top/g, (t) => On[t]);
  }
  function _n(e) {
    return {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      ...e
    };
  }
  function Oe(e) {
    return typeof e != "number" ? _n(e) : {
      top: e,
      right: e,
      bottom: e,
      left: e
    };
  }
  function Nt(e) {
    const { x: t, y: n, width: r, height: i } = e;
    return {
      width: r,
      height: i,
      top: n,
      left: t,
      right: t + r,
      bottom: n + i,
      x: t,
      y: n
    };
  }
  function fe(e, t, n) {
    let { reference: r, floating: i } = e;
    const o = dt(t), s = ee(t), c = te(s), a = it(t), d = o === "y", f = r.x + r.width / 2 - i.width / 2, l = r.y + r.height / 2 - i.height / 2, h = r[c] / 2 - i[c] / 2;
    let u;
    switch (a) {
      case "top":
        u = {
          x: f,
          y: r.y - i.height
        };
        break;
      case "bottom":
        u = {
          x: f,
          y: r.y + r.height
        };
        break;
      case "right":
        u = {
          x: r.x + r.width,
          y: l
        };
        break;
      case "left":
        u = {
          x: r.x - i.width,
          y: l
        };
        break;
      default:
        u = {
          x: r.x,
          y: r.y
        };
    }
    switch (Pt(t)) {
      case "start":
        u[s] -= h * (n && d ? -1 : 1);
        break;
      case "end":
        u[s] += h * (n && d ? -1 : 1);
        break;
    }
    return u;
  }
  const Dn = async (e, t, n) => {
    const { placement: r = "bottom", strategy: i = "absolute", middleware: o = [], platform: s } = n, c = o.filter(Boolean), a = await (s.isRTL == null ? void 0 : s.isRTL(t));
    let d = await s.getElementRects({
      reference: e,
      floating: t,
      strategy: i
    }), { x: f, y: l } = fe(d, r, a), h = r, u = {}, g = 0;
    for (let m = 0; m < c.length; m++) {
      const { name: v, fn: y } = c[m], { x: A, y: x, data: S, reset: p } = await y({
        x: f,
        y: l,
        initialPlacement: r,
        placement: h,
        strategy: i,
        middlewareData: u,
        rects: d,
        platform: s,
        elements: {
          reference: e,
          floating: t
        }
      });
      f = A ?? f, l = x ?? l, u = {
        ...u,
        [v]: {
          ...u[v],
          ...S
        }
      }, p && g <= 50 && (g++, typeof p == "object" && (p.placement && (h = p.placement), p.rects && (d = p.rects === true ? await s.getElementRects({
        reference: e,
        floating: t,
        strategy: i
      }) : p.rects), { x: f, y: l } = fe(d, h, a)), m = -1);
    }
    return {
      x: f,
      y: l,
      placement: h,
      strategy: i,
      middlewareData: u
    };
  };
  async function Ft(e, t) {
    var n;
    t === void 0 && (t = {});
    const { x: r, y: i, platform: o, rects: s, elements: c, strategy: a } = e, { boundary: d = "clippingAncestors", rootBoundary: f = "viewport", elementContext: l = "floating", altBoundary: h = false, padding: u = 0 } = rt(t, e), g = Oe(u), v = c[h ? l === "floating" ? "reference" : "floating" : l], y = Nt(await o.getClippingRect({
      element: (n = await (o.isElement == null ? void 0 : o.isElement(v))) == null || n ? v : v.contextElement || await (o.getDocumentElement == null ? void 0 : o.getDocumentElement(c.floating)),
      boundary: d,
      rootBoundary: f,
      strategy: a
    })), A = l === "floating" ? {
      x: r,
      y: i,
      width: s.floating.width,
      height: s.floating.height
    } : s.reference, x = await (o.getOffsetParent == null ? void 0 : o.getOffsetParent(c.floating)), S = await (o.isElement == null ? void 0 : o.isElement(x)) ? await (o.getScale == null ? void 0 : o.getScale(x)) || {
      x: 1,
      y: 1
    } : {
      x: 1,
      y: 1
    }, p = Nt(o.convertOffsetParentRelativeRectToViewportRelativeRect ? await o.convertOffsetParentRelativeRectToViewportRelativeRect({
      elements: c,
      rect: A,
      offsetParent: x,
      strategy: a
    }) : A);
    return {
      top: (y.top - p.top + g.top) / S.y,
      bottom: (p.bottom - y.bottom + g.bottom) / S.y,
      left: (y.left - p.left + g.left) / S.x,
      right: (p.right - y.right + g.right) / S.x
    };
  }
  const En = (e) => ({
    name: "arrow",
    options: e,
    async fn(t) {
      const { x: n, y: r, placement: i, rects: o, platform: s, elements: c, middlewareData: a } = t, { element: d, padding: f = 0 } = rt(e, t) || {};
      if (d == null) return {};
      const l = Oe(f), h = {
        x: n,
        y: r
      }, u = ee(i), g = te(u), m = await s.getDimensions(d), v = u === "y", y = v ? "top" : "left", A = v ? "bottom" : "right", x = v ? "clientHeight" : "clientWidth", S = o.reference[g] + o.reference[u] - h[u] - o.floating[g], p = h[u] - o.reference[u], C = await (s.getOffsetParent == null ? void 0 : s.getOffsetParent(d));
      let R = C ? C[x] : 0;
      (!R || !await (s.isElement == null ? void 0 : s.isElement(C))) && (R = c.floating[x] || o.floating[g]);
      const F = S / 2 - p / 2, I = R / 2 - m[g] / 2 - 1, E = ut(l[y], I), L = ut(l[A], I), B = E, W = R - m[g] - L, D = R / 2 - m[g] / 2 + F, j = qt(B, D, W), U = !a.arrow && Pt(i) != null && D !== j && o.reference[g] / 2 - (D < B ? E : L) - m[g] / 2 < 0, z = U ? D < B ? D - B : D - W : 0;
      return {
        [u]: h[u] + z,
        data: {
          [u]: j,
          centerOffset: D - j - z,
          ...U && {
            alignmentOffset: z
          }
        },
        reset: U
      };
    }
  }), Bn = function(e) {
    return e === void 0 && (e = {}), {
      name: "flip",
      options: e,
      async fn(t) {
        var n, r;
        const { placement: i, middlewareData: o, rects: s, initialPlacement: c, platform: a, elements: d } = t, { mainAxis: f = true, crossAxis: l = true, fallbackPlacements: h, fallbackStrategy: u = "bestFit", fallbackAxisSideDirection: g = "none", flipAlignment: m = true, ...v } = rt(e, t);
        if ((n = o.arrow) != null && n.alignmentOffset) return {};
        const y = it(i), A = dt(c), x = it(c) === c, S = await (a.isRTL == null ? void 0 : a.isRTL(d.floating)), p = h || (x || !m ? [
          Vt(c)
        ] : Rn(c)), C = g !== "none";
        !h && C && p.push(...Fn(c, m, g, S));
        const R = [
          c,
          ...p
        ], F = await Ft(t, v), I = [];
        let E = ((r = o.flip) == null ? void 0 : r.overflows) || [];
        if (f && I.push(F[y]), l) {
          const D = Cn(i, s, S);
          I.push(F[D[0]], F[D[1]]);
        }
        if (E = [
          ...E,
          {
            placement: i,
            overflows: I
          }
        ], !I.every((D) => D <= 0)) {
          var L, B;
          const D = (((L = o.flip) == null ? void 0 : L.index) || 0) + 1, j = R[D];
          if (j) return {
            data: {
              index: D,
              overflows: E
            },
            reset: {
              placement: j
            }
          };
          let U = (B = E.filter((z) => z.overflows[0] <= 0).sort((z, ot) => z.overflows[1] - ot.overflows[1])[0]) == null ? void 0 : B.placement;
          if (!U) switch (u) {
            case "bestFit": {
              var W;
              const z = (W = E.filter((ot) => {
                if (C) {
                  const st = dt(ot.placement);
                  return st === A || st === "y";
                }
                return true;
              }).map((ot) => [
                ot.placement,
                ot.overflows.filter((st) => st > 0).reduce((st, Le) => st + Le, 0)
              ]).sort((ot, st) => ot[1] - st[1])[0]) == null ? void 0 : W[0];
              z && (U = z);
              break;
            }
            case "initialPlacement":
              U = c;
              break;
          }
          if (i !== U) return {
            reset: {
              placement: U
            }
          };
        }
        return {};
      }
    };
  };
  function ge(e, t) {
    return {
      top: e.top - t.height,
      right: e.right - t.width,
      bottom: e.bottom - t.height,
      left: e.left - t.width
    };
  }
  function he(e) {
    return Sn.some((t) => e[t] >= 0);
  }
  const kn = function(e) {
    return e === void 0 && (e = {}), {
      name: "hide",
      options: e,
      async fn(t) {
        const { rects: n } = t, { strategy: r = "referenceHidden", ...i } = rt(e, t);
        switch (r) {
          case "referenceHidden": {
            const o = await Ft(t, {
              ...i,
              elementContext: "reference"
            }), s = ge(o, n.reference);
            return {
              data: {
                referenceHiddenOffsets: s,
                referenceHidden: he(s)
              }
            };
          }
          case "escaped": {
            const o = await Ft(t, {
              ...i,
              altBoundary: true
            }), s = ge(o, n.floating);
            return {
              data: {
                escapedOffsets: s,
                escaped: he(s)
              }
            };
          }
          default:
            return {};
        }
      }
    };
  };
  async function Mn(e, t) {
    const { placement: n, platform: r, elements: i } = e, o = await (r.isRTL == null ? void 0 : r.isRTL(i.floating)), s = it(n), c = Pt(n), a = dt(n) === "y", d = [
      "left",
      "top"
    ].includes(s) ? -1 : 1, f = o && a ? -1 : 1, l = rt(t, e);
    let { mainAxis: h, crossAxis: u, alignmentAxis: g } = typeof l == "number" ? {
      mainAxis: l,
      crossAxis: 0,
      alignmentAxis: null
    } : {
      mainAxis: l.mainAxis || 0,
      crossAxis: l.crossAxis || 0,
      alignmentAxis: l.alignmentAxis
    };
    return c && typeof g == "number" && (u = c === "end" ? g * -1 : g), a ? {
      x: u * f,
      y: h * d
    } : {
      x: h * d,
      y: u * f
    };
  }
  const In = function(e) {
    return e === void 0 && (e = 0), {
      name: "offset",
      options: e,
      async fn(t) {
        var n, r;
        const { x: i, y: o, placement: s, middlewareData: c } = t, a = await Mn(t, e);
        return s === ((n = c.offset) == null ? void 0 : n.placement) && (r = c.arrow) != null && r.alignmentOffset ? {} : {
          x: i + a.x,
          y: o + a.y,
          data: {
            ...a,
            placement: s
          }
        };
      }
    };
  }, Ln = function(e) {
    return e === void 0 && (e = {}), {
      name: "shift",
      options: e,
      async fn(t) {
        const { x: n, y: r, placement: i } = t, { mainAxis: o = true, crossAxis: s = false, limiter: c = {
          fn: (v) => {
            let { x: y, y: A } = v;
            return {
              x: y,
              y: A
            };
          }
        }, ...a } = rt(e, t), d = {
          x: n,
          y: r
        }, f = await Ft(t, a), l = dt(it(i)), h = $t(l);
        let u = d[h], g = d[l];
        if (o) {
          const v = h === "y" ? "top" : "left", y = h === "y" ? "bottom" : "right", A = u + f[v], x = u - f[y];
          u = qt(A, u, x);
        }
        if (s) {
          const v = l === "y" ? "top" : "left", y = l === "y" ? "bottom" : "right", A = g + f[v], x = g - f[y];
          g = qt(A, g, x);
        }
        const m = c.fn({
          ...t,
          [h]: u,
          [l]: g
        });
        return {
          ...m,
          data: {
            x: m.x - n,
            y: m.y - r,
            enabled: {
              [h]: o,
              [l]: s
            }
          }
        };
      }
    };
  }, Wn = function(e) {
    return e === void 0 && (e = {}), {
      options: e,
      fn(t) {
        const { x: n, y: r, placement: i, rects: o, middlewareData: s } = t, { offset: c = 0, mainAxis: a = true, crossAxis: d = true } = rt(e, t), f = {
          x: n,
          y: r
        }, l = dt(i), h = $t(l);
        let u = f[h], g = f[l];
        const m = rt(c, t), v = typeof m == "number" ? {
          mainAxis: m,
          crossAxis: 0
        } : {
          mainAxis: 0,
          crossAxis: 0,
          ...m
        };
        if (a) {
          const x = h === "y" ? "height" : "width", S = o.reference[h] - o.floating[x] + v.mainAxis, p = o.reference[h] + o.reference[x] - v.mainAxis;
          u < S ? u = S : u > p && (u = p);
        }
        if (d) {
          var y, A;
          const x = h === "y" ? "width" : "height", S = [
            "top",
            "left"
          ].includes(it(i)), p = o.reference[l] - o.floating[x] + (S && ((y = s.offset) == null ? void 0 : y[l]) || 0) + (S ? 0 : v.crossAxis), C = o.reference[l] + o.reference[x] + (S ? 0 : ((A = s.offset) == null ? void 0 : A[l]) || 0) - (S ? v.crossAxis : 0);
          g < p ? g = p : g > C && (g = C);
        }
        return {
          [h]: u,
          [l]: g
        };
      }
    };
  }, Vn = function(e) {
    return e === void 0 && (e = {}), {
      name: "size",
      options: e,
      async fn(t) {
        var n, r;
        const { placement: i, rects: o, platform: s, elements: c } = t, { apply: a = () => {
        }, ...d } = rt(e, t), f = await Ft(t, d), l = it(i), h = Pt(i), u = dt(i) === "y", { width: g, height: m } = o.floating;
        let v, y;
        l === "top" || l === "bottom" ? (v = l, y = h === (await (s.isRTL == null ? void 0 : s.isRTL(c.floating)) ? "start" : "end") ? "left" : "right") : (y = l, v = h === "end" ? "top" : "bottom");
        const A = m - f.top - f.bottom, x = g - f.left - f.right, S = ut(m - f[v], A), p = ut(g - f[y], x), C = !t.middlewareData.shift;
        let R = S, F = p;
        if ((n = t.middlewareData.shift) != null && n.enabled.x && (F = x), (r = t.middlewareData.shift) != null && r.enabled.y && (R = A), C && !h) {
          const E = N(f.left, 0), L = N(f.right, 0), B = N(f.top, 0), W = N(f.bottom, 0);
          u ? F = g - 2 * (E !== 0 || L !== 0 ? E + L : N(f.left, f.right)) : R = m - 2 * (B !== 0 || W !== 0 ? B + W : N(f.top, f.bottom));
        }
        await a({
          ...t,
          availableWidth: F,
          availableHeight: R
        });
        const I = await s.getDimensions(c.floating);
        return g !== I.width || m !== I.height ? {
          reset: {
            rects: true
          }
        } : {};
      }
    };
  };
  function Ht() {
    return typeof window < "u";
  }
  function Ct(e) {
    return Pe(e) ? (e.nodeName || "").toLowerCase() : "#document";
  }
  function H(e) {
    var t;
    return (e == null || (t = e.ownerDocument) == null ? void 0 : t.defaultView) || window;
  }
  function et(e) {
    var t;
    return (t = (Pe(e) ? e.ownerDocument : e.document) || window.document) == null ? void 0 : t.documentElement;
  }
  function Pe(e) {
    return Ht() ? e instanceof Node || e instanceof H(e).Node : false;
  }
  function X(e) {
    return Ht() ? e instanceof Element || e instanceof H(e).Element : false;
  }
  function G(e) {
    return Ht() ? e instanceof HTMLElement || e instanceof H(e).HTMLElement : false;
  }
  function me(e) {
    return !Ht() || typeof ShadowRoot > "u" ? false : e instanceof ShadowRoot || e instanceof H(e).ShadowRoot;
  }
  function Et(e) {
    const { overflow: t, overflowX: n, overflowY: r, display: i } = q(e);
    return /auto|scroll|overlay|hidden|clip/.test(t + r + n) && ![
      "inline",
      "contents"
    ].includes(i);
  }
  function Nn(e) {
    return [
      "table",
      "td",
      "th"
    ].includes(Ct(e));
  }
  function zt(e) {
    return [
      ":popover-open",
      ":modal"
    ].some((t) => {
      try {
        return e.matches(t);
      } catch {
        return false;
      }
    });
  }
  function ne(e) {
    const t = re(), n = X(e) ? q(e) : e;
    return [
      "transform",
      "translate",
      "scale",
      "rotate",
      "perspective"
    ].some((r) => n[r] ? n[r] !== "none" : false) || (n.containerType ? n.containerType !== "normal" : false) || !t && (n.backdropFilter ? n.backdropFilter !== "none" : false) || !t && (n.filter ? n.filter !== "none" : false) || [
      "transform",
      "translate",
      "scale",
      "rotate",
      "perspective",
      "filter"
    ].some((r) => (n.willChange || "").includes(r)) || [
      "paint",
      "layout",
      "strict",
      "content"
    ].some((r) => (n.contain || "").includes(r));
  }
  function Hn(e) {
    let t = ft(e);
    for (; G(t) && !St(t); ) {
      if (ne(t)) return t;
      if (zt(t)) return null;
      t = ft(t);
    }
    return null;
  }
  function re() {
    return typeof CSS > "u" || !CSS.supports ? false : CSS.supports("-webkit-backdrop-filter", "none");
  }
  function St(e) {
    return [
      "html",
      "body",
      "#document"
    ].includes(Ct(e));
  }
  function q(e) {
    return H(e).getComputedStyle(e);
  }
  function Kt(e) {
    return X(e) ? {
      scrollLeft: e.scrollLeft,
      scrollTop: e.scrollTop
    } : {
      scrollLeft: e.scrollX,
      scrollTop: e.scrollY
    };
  }
  function ft(e) {
    if (Ct(e) === "html") return e;
    const t = e.assignedSlot || e.parentNode || me(e) && e.host || et(e);
    return me(t) ? t.host : t;
  }
  function Ce(e) {
    const t = ft(e);
    return St(t) ? e.ownerDocument ? e.ownerDocument.body : e.body : G(t) && Et(t) ? t : Ce(t);
  }
  function _t(e, t, n) {
    var r;
    t === void 0 && (t = []), n === void 0 && (n = true);
    const i = Ce(e), o = i === ((r = e.ownerDocument) == null ? void 0 : r.body), s = H(i);
    if (o) {
      const c = Zt(s);
      return t.concat(s, s.visualViewport || [], Et(i) ? i : [], c && n ? _t(c) : []);
    }
    return t.concat(i, _t(i, [], n));
  }
  function Zt(e) {
    return e.parent && Object.getPrototypeOf(e.parent) ? e.frameElement : null;
  }
  function Re(e) {
    const t = q(e);
    let n = parseFloat(t.width) || 0, r = parseFloat(t.height) || 0;
    const i = G(e), o = i ? e.offsetWidth : n, s = i ? e.offsetHeight : r, c = Wt(n) !== o || Wt(r) !== s;
    return c && (n = o, r = s), {
      width: n,
      height: r,
      $: c
    };
  }
  function ie(e) {
    return X(e) ? e : e.contextElement;
  }
  function bt(e) {
    const t = ie(e);
    if (!G(t)) return Q(1);
    const n = t.getBoundingClientRect(), { width: r, height: i, $: o } = Re(t);
    let s = (o ? Wt(n.width) : n.width) / r, c = (o ? Wt(n.height) : n.height) / i;
    return (!s || !Number.isFinite(s)) && (s = 1), (!c || !Number.isFinite(c)) && (c = 1), {
      x: s,
      y: c
    };
  }
  const zn = Q(0);
  function Te(e) {
    const t = H(e);
    return !re() || !t.visualViewport ? zn : {
      x: t.visualViewport.offsetLeft,
      y: t.visualViewport.offsetTop
    };
  }
  function Kn(e, t, n) {
    return t === void 0 && (t = false), !n || t && n !== H(e) ? false : t;
  }
  function mt(e, t, n, r) {
    t === void 0 && (t = false), n === void 0 && (n = false);
    const i = e.getBoundingClientRect(), o = ie(e);
    let s = Q(1);
    t && (r ? X(r) && (s = bt(r)) : s = bt(e));
    const c = Kn(o, n, r) ? Te(o) : Q(0);
    let a = (i.left + c.x) / s.x, d = (i.top + c.y) / s.y, f = i.width / s.x, l = i.height / s.y;
    if (o) {
      const h = H(o), u = r && X(r) ? H(r) : r;
      let g = h, m = Zt(g);
      for (; m && r && u !== g; ) {
        const v = bt(m), y = m.getBoundingClientRect(), A = q(m), x = y.left + (m.clientLeft + parseFloat(A.paddingLeft)) * v.x, S = y.top + (m.clientTop + parseFloat(A.paddingTop)) * v.y;
        a *= v.x, d *= v.y, f *= v.x, l *= v.y, a += x, d += S, g = H(m), m = Zt(g);
      }
    }
    return Nt({
      width: f,
      height: l,
      x: a,
      y: d
    });
  }
  function oe(e, t) {
    const n = Kt(e).scrollLeft;
    return t ? t.left + n : mt(et(e)).left + n;
  }
  function Fe(e, t, n) {
    n === void 0 && (n = false);
    const r = e.getBoundingClientRect(), i = r.left + t.scrollLeft - (n ? 0 : oe(e, r)), o = r.top + t.scrollTop;
    return {
      x: i,
      y: o
    };
  }
  function Yn(e) {
    let { elements: t, rect: n, offsetParent: r, strategy: i } = e;
    const o = i === "fixed", s = et(r), c = t ? zt(t.floating) : false;
    if (r === s || c && o) return n;
    let a = {
      scrollLeft: 0,
      scrollTop: 0
    }, d = Q(1);
    const f = Q(0), l = G(r);
    if ((l || !l && !o) && ((Ct(r) !== "body" || Et(s)) && (a = Kt(r)), G(r))) {
      const u = mt(r);
      d = bt(r), f.x = u.x + r.clientLeft, f.y = u.y + r.clientTop;
    }
    const h = s && !l && !o ? Fe(s, a, true) : Q(0);
    return {
      width: n.width * d.x,
      height: n.height * d.y,
      x: n.x * d.x - a.scrollLeft * d.x + f.x + h.x,
      y: n.y * d.y - a.scrollTop * d.y + f.y + h.y
    };
  }
  function Un(e) {
    return Array.from(e.getClientRects());
  }
  function Xn(e) {
    const t = et(e), n = Kt(e), r = e.ownerDocument.body, i = N(t.scrollWidth, t.clientWidth, r.scrollWidth, r.clientWidth), o = N(t.scrollHeight, t.clientHeight, r.scrollHeight, r.clientHeight);
    let s = -n.scrollLeft + oe(e);
    const c = -n.scrollTop;
    return q(r).direction === "rtl" && (s += N(t.clientWidth, r.clientWidth) - i), {
      width: i,
      height: o,
      x: s,
      y: c
    };
  }
  function qn(e, t) {
    const n = H(e), r = et(e), i = n.visualViewport;
    let o = r.clientWidth, s = r.clientHeight, c = 0, a = 0;
    if (i) {
      o = i.width, s = i.height;
      const d = re();
      (!d || d && t === "fixed") && (c = i.offsetLeft, a = i.offsetTop);
    }
    return {
      width: o,
      height: s,
      x: c,
      y: a
    };
  }
  function jn(e, t) {
    const n = mt(e, true, t === "fixed"), r = n.top + e.clientTop, i = n.left + e.clientLeft, o = G(e) ? bt(e) : Q(1), s = e.clientWidth * o.x, c = e.clientHeight * o.y, a = i * o.x, d = r * o.y;
    return {
      width: s,
      height: c,
      x: a,
      y: d
    };
  }
  function we(e, t, n) {
    let r;
    if (t === "viewport") r = qn(e, n);
    else if (t === "document") r = Xn(et(e));
    else if (X(t)) r = jn(t, n);
    else {
      const i = Te(e);
      r = {
        x: t.x - i.x,
        y: t.y - i.y,
        width: t.width,
        height: t.height
      };
    }
    return Nt(r);
  }
  function _e(e, t) {
    const n = ft(e);
    return n === t || !X(n) || St(n) ? false : q(n).position === "fixed" || _e(n, t);
  }
  function Zn(e, t) {
    const n = t.get(e);
    if (n) return n;
    let r = _t(e, [], false).filter((c) => X(c) && Ct(c) !== "body"), i = null;
    const o = q(e).position === "fixed";
    let s = o ? ft(e) : e;
    for (; X(s) && !St(s); ) {
      const c = q(s), a = ne(s);
      !a && c.position === "fixed" && (i = null), (o ? !a && !i : !a && c.position === "static" && !!i && [
        "absolute",
        "fixed"
      ].includes(i.position) || Et(s) && !a && _e(e, s)) ? r = r.filter((f) => f !== s) : i = c, s = ft(s);
    }
    return t.set(e, r), r;
  }
  function Qn(e) {
    let { element: t, boundary: n, rootBoundary: r, strategy: i } = e;
    const s = [
      ...n === "clippingAncestors" ? zt(t) ? [] : Zn(t, this._c) : [].concat(n),
      r
    ], c = s[0], a = s.reduce((d, f) => {
      const l = we(t, f, i);
      return d.top = N(l.top, d.top), d.right = ut(l.right, d.right), d.bottom = ut(l.bottom, d.bottom), d.left = N(l.left, d.left), d;
    }, we(t, c, i));
    return {
      width: a.right - a.left,
      height: a.bottom - a.top,
      x: a.left,
      y: a.top
    };
  }
  function Jn(e) {
    const { width: t, height: n } = Re(e);
    return {
      width: t,
      height: n
    };
  }
  function Gn(e, t, n) {
    const r = G(t), i = et(t), o = n === "fixed", s = mt(e, true, o, t);
    let c = {
      scrollLeft: 0,
      scrollTop: 0
    };
    const a = Q(0);
    if (r || !r && !o) if ((Ct(t) !== "body" || Et(i)) && (c = Kt(t)), r) {
      const h = mt(t, true, o, t);
      a.x = h.x + t.clientLeft, a.y = h.y + t.clientTop;
    } else i && (a.x = oe(i));
    const d = i && !r && !o ? Fe(i, c) : Q(0), f = s.left + c.scrollLeft - a.x - d.x, l = s.top + c.scrollTop - a.y - d.y;
    return {
      x: f,
      y: l,
      width: s.width,
      height: s.height
    };
  }
  function Ut(e) {
    return q(e).position === "static";
  }
  function ve(e, t) {
    if (!G(e) || q(e).position === "fixed") return null;
    if (t) return t(e);
    let n = e.offsetParent;
    return et(e) === n && (n = n.ownerDocument.body), n;
  }
  function De(e, t) {
    const n = H(e);
    if (zt(e)) return n;
    if (!G(e)) {
      let i = ft(e);
      for (; i && !St(i); ) {
        if (X(i) && !Ut(i)) return i;
        i = ft(i);
      }
      return n;
    }
    let r = ve(e, t);
    for (; r && Nn(r) && Ut(r); ) r = ve(r, t);
    return r && St(r) && Ut(r) && !ne(r) ? n : r || Hn(e) || n;
  }
  const $n = async function(e) {
    const t = this.getOffsetParent || De, n = this.getDimensions, r = await n(e.floating);
    return {
      reference: Gn(e.reference, await t(e.floating), e.strategy),
      floating: {
        x: 0,
        y: 0,
        width: r.width,
        height: r.height
      }
    };
  };
  function tr(e) {
    return q(e).direction === "rtl";
  }
  const er = {
    convertOffsetParentRelativeRectToViewportRelativeRect: Yn,
    getDocumentElement: et,
    getClippingRect: Qn,
    getOffsetParent: De,
    getElementRects: $n,
    getClientRects: Un,
    getDimensions: Jn,
    getScale: bt,
    isElement: X,
    isRTL: tr
  };
  function Ee(e, t) {
    return e.x === t.x && e.y === t.y && e.width === t.width && e.height === t.height;
  }
  function nr(e, t) {
    let n = null, r;
    const i = et(e);
    function o() {
      var c;
      clearTimeout(r), (c = n) == null || c.disconnect(), n = null;
    }
    function s(c, a) {
      c === void 0 && (c = false), a === void 0 && (a = 1), o();
      const d = e.getBoundingClientRect(), { left: f, top: l, width: h, height: u } = d;
      if (c || t(), !h || !u) return;
      const g = kt(l), m = kt(i.clientWidth - (f + h)), v = kt(i.clientHeight - (l + u)), y = kt(f), x = {
        rootMargin: -g + "px " + -m + "px " + -v + "px " + -y + "px",
        threshold: N(0, ut(1, a)) || 1
      };
      let S = true;
      function p(C) {
        const R = C[0].intersectionRatio;
        if (R !== a) {
          if (!S) return s();
          R ? s(false, R) : r = setTimeout(() => {
            s(false, 1e-7);
          }, 1e3);
        }
        R === 1 && !Ee(d, e.getBoundingClientRect()) && s(), S = false;
      }
      try {
        n = new IntersectionObserver(p, {
          ...x,
          root: i.ownerDocument
        });
      } catch {
        n = new IntersectionObserver(p, x);
      }
      n.observe(e);
    }
    return s(true), o;
  }
  function rr(e, t, n, r) {
    r === void 0 && (r = {});
    const { ancestorScroll: i = true, ancestorResize: o = true, elementResize: s = typeof ResizeObserver == "function", layoutShift: c = typeof IntersectionObserver == "function", animationFrame: a = false } = r, d = ie(e), f = i || o ? [
      ...d ? _t(d) : [],
      ..._t(t)
    ] : [];
    f.forEach((y) => {
      i && y.addEventListener("scroll", n, {
        passive: true
      }), o && y.addEventListener("resize", n);
    });
    const l = d && c ? nr(d, n) : null;
    let h = -1, u = null;
    s && (u = new ResizeObserver((y) => {
      let [A] = y;
      A && A.target === d && u && (u.unobserve(t), cancelAnimationFrame(h), h = requestAnimationFrame(() => {
        var x;
        (x = u) == null || x.observe(t);
      })), n();
    }), d && !a && u.observe(d), u.observe(t));
    let g, m = a ? mt(e) : null;
    a && v();
    function v() {
      const y = mt(e);
      m && !Ee(m, y) && n(), m = y, g = requestAnimationFrame(v);
    }
    return n(), () => {
      var y;
      f.forEach((A) => {
        i && A.removeEventListener("scroll", n), o && A.removeEventListener("resize", n);
      }), l?.(), (y = u) == null || y.disconnect(), u = null, a && cancelAnimationFrame(g);
    };
  }
  const ir = In, or = Ln, sr = Bn, ar = Vn, cr = kn, lr = En, ur = Wn, dr = (e, t, n) => {
    const r = /* @__PURE__ */ new Map(), i = {
      platform: er,
      ...n
    }, o = {
      ...i.platform,
      _c: r
    };
    return Dn(e, t, {
      ...i,
      platform: o
    });
  };
  function Rt(e) {
    return typeof e == "function" ? e() : e;
  }
  function Be(e) {
    return typeof window > "u" ? 1 : (e.ownerDocument.defaultView || window).devicePixelRatio || 1;
  }
  function ye(e, t) {
    const n = Be(e);
    return Math.round(t * n) / n;
  }
  ui = function(e) {
    return {
      [`--bits-${e}-content-transform-origin`]: "var(--bits-floating-transform-origin)",
      [`--bits-${e}-content-available-width`]: "var(--bits-floating-available-width)",
      [`--bits-${e}-content-available-height`]: "var(--bits-floating-available-height)",
      [`--bits-${e}-anchor-width`]: "var(--bits-floating-anchor-width)",
      [`--bits-${e}-anchor-height`]: "var(--bits-floating-anchor-height)"
    };
  };
  function fr(e) {
    const t = e.whileElementsMounted, n = T(() => Rt(e.open) ?? true), r = T(() => Rt(e.middleware)), i = T(() => Rt(e.transform) ?? true), o = T(() => Rt(e.placement) ?? "bottom"), s = T(() => Rt(e.strategy) ?? "absolute"), c = e.reference;
    let a = Y(0), d = Y(0);
    const f = O(null);
    let l = Y(M(w(s))), h = Y(M(w(o))), u = Y(M({})), g = Y(false);
    const m = T(() => {
      const p = {
        position: w(l),
        left: "0",
        top: "0"
      };
      if (!f.current) return p;
      const C = ye(f.current, w(a)), R = ye(f.current, w(d));
      return w(i) ? {
        ...p,
        transform: `translate(${C}px, ${R}px)`,
        ...Be(f.current) >= 1.5 && {
          willChange: "transform"
        }
      } : {
        position: w(l),
        left: `${C}px`,
        top: `${R}px`
      };
    });
    let v;
    function y() {
      c.current === null || f.current === null || dr(c.current, f.current, {
        middleware: w(r),
        placement: w(o),
        strategy: w(s)
      }).then((p) => {
        K(a, M(p.x)), K(d, M(p.y)), K(l, M(p.strategy)), K(h, M(p.placement)), K(u, M(p.middlewareData)), K(g, true);
      });
    }
    function A() {
      typeof v == "function" && (v(), v = void 0);
    }
    function x() {
      if (A(), t === void 0) {
        y();
        return;
      }
      c.current === null || f.current === null || (v = t(c.current, f.current, y));
    }
    function S() {
      w(n) || K(g, false);
    }
    return at(y), at(x), at(S), at(() => A), {
      floating: f,
      reference: c,
      get strategy() {
        return w(l);
      },
      get placement() {
        return w(h);
      },
      get middlewareData() {
        return w(u);
      },
      get isPositioned() {
        return w(g);
      },
      get floatingStyles() {
        return w(m);
      },
      get update() {
        return y;
      }
    };
  }
  const gr = {
    top: "bottom",
    right: "left",
    bottom: "top",
    left: "right"
  };
  class hr {
    anchorNode = O(null);
    customAnchorNode = O(null);
    triggerNode = O(null);
    constructor() {
      at(() => {
        this.customAnchorNode.current ? typeof this.customAnchorNode.current == "string" ? this.anchorNode.current = document.querySelector(this.customAnchorNode.current) : this.anchorNode.current = this.customAnchorNode.current : this.anchorNode.current = this.triggerNode.current;
      });
    }
  }
  class mr {
    opts;
    root;
    contentRef = O(null);
    wrapperRef = O(null);
    arrowRef = O(null);
    arrowId = O(Dt());
    #t = T(() => {
      if (typeof this.opts.style == "string") return Ye(this.opts.style);
      if (!this.opts.style) return {};
    });
    #l = void 0;
    #e = new on(() => this.arrowRef.current ?? void 0);
    #u = T(() => this.#e?.width ?? 0);
    #n = T(() => this.#e?.height ?? 0);
    #d = T(() => this.opts.side?.current + (this.opts.align.current !== "center" ? `-${this.opts.align.current}` : ""));
    #r = T(() => Array.isArray(this.opts.collisionBoundary.current) ? this.opts.collisionBoundary.current : [
      this.opts.collisionBoundary.current
    ]);
    #f = T(() => w(this.#r).length > 0);
    get hasExplicitBoundaries() {
      return w(this.#f);
    }
    #g = T(() => ({
      padding: this.opts.collisionPadding.current,
      boundary: w(this.#r).filter(Ue),
      altBoundary: this.hasExplicitBoundaries
    }));
    get detectOverflowOptions() {
      return w(this.#g);
    }
    #i = Y(void 0);
    #o = Y(void 0);
    #s = Y(void 0);
    #a = Y(void 0);
    #h = T(() => [
      ir({
        mainAxis: this.opts.sideOffset.current + w(this.#n),
        alignmentAxis: this.opts.alignOffset.current
      }),
      this.opts.avoidCollisions.current && or({
        mainAxis: true,
        crossAxis: false,
        limiter: this.opts.sticky.current === "partial" ? ur() : void 0,
        ...this.detectOverflowOptions
      }),
      this.opts.avoidCollisions.current && sr({
        ...this.detectOverflowOptions
      }),
      ar({
        ...this.detectOverflowOptions,
        apply: ({ rects: t, availableWidth: n, availableHeight: r }) => {
          const { width: i, height: o } = t.reference;
          K(this.#i, M(n)), K(this.#o, M(r)), K(this.#s, M(i)), K(this.#a, M(o));
        }
      }),
      this.arrowRef.current && lr({
        element: this.arrowRef.current,
        padding: this.opts.arrowPadding.current
      }),
      br({
        arrowWidth: w(this.#u),
        arrowHeight: w(this.#n)
      }),
      this.opts.hideWhenDetached.current && cr({
        strategy: "referenceHidden",
        ...this.detectOverflowOptions
      })
    ].filter(Boolean));
    get middleware() {
      return w(this.#h);
    }
    floating;
    #m = T(() => Ar(this.floating.placement));
    get placedSide() {
      return w(this.#m);
    }
    #w = T(() => Sr(this.floating.placement));
    get placedAlign() {
      return w(this.#w);
    }
    #v = T(() => this.floating.middlewareData.arrow?.x ?? 0);
    get arrowX() {
      return w(this.#v);
    }
    #y = T(() => this.floating.middlewareData.arrow?.y ?? 0);
    get arrowY() {
      return w(this.#y);
    }
    #p = T(() => this.floating.middlewareData.arrow?.centerOffset !== 0);
    get cannotCenterArrow() {
      return w(this.#p);
    }
    #c = Y();
    get contentZIndex() {
      return w(this.#c);
    }
    set contentZIndex(t) {
      K(this.#c, M(t));
    }
    #x = T(() => gr[this.placedSide]);
    get arrowBaseSide() {
      return w(this.#x);
    }
    #b = T(() => ({
      id: this.opts.wrapperId.current,
      "data-bits-floating-content-wrapper": "",
      style: {
        ...this.floating.floatingStyles,
        transform: this.floating.isPositioned ? this.floating.floatingStyles.transform : "translate(0, -200%)",
        minWidth: "max-content",
        zIndex: this.contentZIndex,
        "--bits-floating-transform-origin": `${this.floating.middlewareData.transformOrigin?.x} ${this.floating.middlewareData.transformOrigin?.y}`,
        "--bits-floating-available-width": `${w(this.#i)}px`,
        "--bits-floating-available-height": `${w(this.#o)}px`,
        "--bits-floating-anchor-width": `${w(this.#s)}px`,
        "--bits-floating-anchor-height": `${w(this.#a)}px`,
        ...this.floating.middlewareData.hide?.referenceHidden && {
          visibility: "hidden",
          "pointer-events": "none"
        },
        ...w(this.#t)
      },
      dir: this.opts.dir.current
    }));
    get wrapperProps() {
      return w(this.#b);
    }
    #A = T(() => ({
      "data-side": this.placedSide,
      "data-align": this.placedAlign,
      style: Xe({
        ...w(this.#t)
      })
    }));
    get props() {
      return w(this.#A);
    }
    #S = T(() => ({
      position: "absolute",
      left: this.arrowX ? `${this.arrowX}px` : void 0,
      top: this.arrowY ? `${this.arrowY}px` : void 0,
      [this.arrowBaseSide]: 0,
      "transform-origin": {
        top: "",
        right: "0 0",
        bottom: "center 0",
        left: "100% 0"
      }[this.placedSide],
      transform: {
        top: "translateY(100%)",
        right: "translateY(50%) rotate(90deg) translateX(-50%)",
        bottom: "rotate(180deg)",
        left: "translateY(50%) rotate(-90deg) translateX(50%)"
      }[this.placedSide],
      visibility: this.cannotCenterArrow ? "hidden" : void 0
    }));
    get arrowStyle() {
      return w(this.#S);
    }
    constructor(t, n) {
      this.opts = t, this.root = n, t.customAnchor && (this.root.customAnchorNode.current = t.customAnchor.current), ue(() => t.customAnchor.current, (r) => {
        this.root.customAnchorNode.current = r;
      }), At({
        id: this.opts.wrapperId,
        ref: this.wrapperRef,
        deps: () => this.opts.enabled.current
      }), At({
        id: this.opts.id,
        ref: this.contentRef,
        deps: () => this.opts.enabled.current
      }), this.floating = fr({
        strategy: () => this.opts.strategy.current,
        placement: () => w(this.#d),
        middleware: () => this.middleware,
        reference: this.root.anchorNode,
        whileElementsMounted: (...r) => rr(...r, {
          animationFrame: this.#l?.current === "always"
        }),
        open: () => this.opts.enabled.current
      }), at(() => {
        this.floating.isPositioned && this.opts.onPlaced?.current();
      }), ue(() => this.contentRef.current, (r) => {
        r && (this.contentZIndex = window.getComputedStyle(r).zIndex);
      }), at(() => {
        this.floating.floating.current = this.wrapperRef.current;
      });
    }
  }
  class wr {
    opts;
    root;
    ref = O(null);
    constructor(t, n) {
      this.opts = t, this.root = n, t.virtualEl && t.virtualEl.current ? n.triggerNode = O.from(t.virtualEl.current) : At({
        id: t.id,
        ref: this.ref,
        onRefChange: (r) => {
          n.triggerNode.current = r;
        }
      });
    }
  }
  const se = new Jt("Floating.Root"), vr = new Jt("Floating.Content");
  function yr() {
    return se.set(new hr());
  }
  function pr(e) {
    return vr.set(new mr(e, se.get()));
  }
  function xr(e) {
    return new wr(e, se.get());
  }
  function br(e) {
    return {
      name: "transformOrigin",
      options: e,
      fn(t) {
        const { placement: n, rects: r, middlewareData: i } = t, s = i.arrow?.centerOffset !== 0, c = s ? 0 : e.arrowWidth, a = s ? 0 : e.arrowHeight, [d, f] = ae(n), l = {
          start: "0%",
          center: "50%",
          end: "100%"
        }[f], h = (i.arrow?.x ?? 0) + c / 2, u = (i.arrow?.y ?? 0) + a / 2;
        let g = "", m = "";
        return d === "bottom" ? (g = s ? l : `${h}px`, m = `${-a}px`) : d === "top" ? (g = s ? l : `${h}px`, m = `${r.floating.height + a}px`) : d === "right" ? (g = `${-a}px`, m = s ? l : `${u}px`) : d === "left" && (g = `${r.floating.width + a}px`, m = s ? l : `${u}px`), {
          data: {
            x: g,
            y: m
          }
        };
      }
    };
  }
  function ae(e) {
    const [t, n = "center"] = e.split("-");
    return [
      t,
      n
    ];
  }
  function Ar(e) {
    return ae(e)[0];
  }
  function Sr(e) {
    return ae(e)[1];
  }
  di = function(e, t) {
    $(t, true), yr();
    var n = V(), r = k(n);
    J(r, () => t.children ?? wt), _(e, n), tt();
  };
  fi = function(e, t) {
    $(t, true), xr({
      id: O.with(() => t.id),
      virtualEl: O.with(() => t.virtualEl)
    });
    var n = V(), r = k(n);
    J(r, () => t.children ?? wt), _(e, n), tt();
  };
  function Or(e, t) {
    $(t, true);
    let n = b(t, "side", 3, "bottom"), r = b(t, "sideOffset", 3, 0), i = b(t, "align", 3, "center"), o = b(t, "alignOffset", 3, 0), s = b(t, "arrowPadding", 3, 0), c = b(t, "avoidCollisions", 3, true), a = b(t, "collisionBoundary", 19, () => []), d = b(t, "collisionPadding", 3, 0), f = b(t, "hideWhenDetached", 3, false), l = b(t, "onPlaced", 3, () => {
    }), h = b(t, "sticky", 3, "partial"), u = b(t, "updatePositionStrategy", 3, "optimized"), g = b(t, "strategy", 3, "fixed"), m = b(t, "dir", 3, "ltr"), v = b(t, "style", 19, () => ({})), y = b(t, "wrapperId", 19, Dt), A = b(t, "customAnchor", 3, null);
    const x = pr({
      side: O.with(() => n()),
      sideOffset: O.with(() => r()),
      align: O.with(() => i()),
      alignOffset: O.with(() => o()),
      id: O.with(() => t.id),
      arrowPadding: O.with(() => s()),
      avoidCollisions: O.with(() => c()),
      collisionBoundary: O.with(() => a()),
      collisionPadding: O.with(() => d()),
      hideWhenDetached: O.with(() => f()),
      onPlaced: O.with(() => l()),
      sticky: O.with(() => h()),
      updatePositionStrategy: O.with(() => u()),
      strategy: O.with(() => g()),
      dir: O.with(() => m()),
      style: O.with(() => v()),
      enabled: O.with(() => t.enabled),
      wrapperId: O.with(() => y()),
      customAnchor: O.with(() => A())
    }), S = T(() => Ot(x.wrapperProps, {
      style: {
        pointerEvents: "auto"
      }
    }));
    var p = V(), C = k(p);
    J(C, () => t.content ?? wt, () => ({
      props: x.props,
      wrapperProps: w(S)
    })), _(e, p), tt();
  }
  function Pr(e, t) {
    $(t, true), Ge(() => {
      t.onPlaced?.();
    });
    var n = V(), r = k(n);
    J(r, () => t.content ?? wt, () => ({
      props: {},
      wrapperProps: {}
    })), _(e, n), tt();
  }
  function Cr(e, t) {
    let n = b(t, "isStatic", 3, false), r = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "content",
      "isStatic",
      "onPlaced"
    ]);
    var i = V(), o = k(i);
    {
      var s = (a) => {
        Pr(a, {
          get content() {
            return t.content;
          },
          get onPlaced() {
            return t.onPlaced;
          }
        });
      }, c = (a) => {
        Or(a, Lt({
          get content() {
            return t.content;
          },
          get onPlaced() {
            return t.onPlaced;
          }
        }, () => r));
      };
      lt(o, (a) => {
        n() ? a(s) : a(c, false);
      });
    }
    _(e, i);
  }
  var Rr = vt("<!> <!>", 1);
  function ke(e, t) {
    $(t, true);
    let n = b(t, "interactOutsideBehavior", 3, "close"), r = b(t, "trapFocus", 3, true), i = b(t, "isValidEvent", 3, () => false), o = b(t, "customAnchor", 3, null), s = b(t, "isStatic", 3, false), c = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "popper",
      "onEscapeKeydown",
      "escapeKeydownBehavior",
      "preventOverflowTextSelection",
      "id",
      "onPointerDown",
      "onPointerUp",
      "side",
      "sideOffset",
      "align",
      "alignOffset",
      "arrowPadding",
      "avoidCollisions",
      "collisionBoundary",
      "collisionPadding",
      "sticky",
      "hideWhenDetached",
      "updatePositionStrategy",
      "strategy",
      "dir",
      "preventScroll",
      "wrapperId",
      "style",
      "onPlaced",
      "onInteractOutside",
      "onCloseAutoFocus",
      "onOpenAutoFocus",
      "onFocusOutside",
      "interactOutsideBehavior",
      "loop",
      "trapFocus",
      "isValidEvent",
      "customAnchor",
      "isStatic",
      "enabled"
    ]);
    Cr(e, {
      get isStatic() {
        return s();
      },
      get id() {
        return t.id;
      },
      get side() {
        return t.side;
      },
      get sideOffset() {
        return t.sideOffset;
      },
      get align() {
        return t.align;
      },
      get alignOffset() {
        return t.alignOffset;
      },
      get arrowPadding() {
        return t.arrowPadding;
      },
      get avoidCollisions() {
        return t.avoidCollisions;
      },
      get collisionBoundary() {
        return t.collisionBoundary;
      },
      get collisionPadding() {
        return t.collisionPadding;
      },
      get sticky() {
        return t.sticky;
      },
      get hideWhenDetached() {
        return t.hideWhenDetached;
      },
      get updatePositionStrategy() {
        return t.updatePositionStrategy;
      },
      get strategy() {
        return t.strategy;
      },
      get dir() {
        return t.dir;
      },
      get wrapperId() {
        return t.wrapperId;
      },
      get style() {
        return t.style;
      },
      get onPlaced() {
        return t.onPlaced;
      },
      get customAnchor() {
        return o();
      },
      get enabled() {
        return t.enabled;
      },
      content: (d, f) => {
        let l = () => f?.().props, h = () => f?.().wrapperProps;
        var u = Rr(), g = k(u);
        {
          var m = (x) => {
            de(x, {
              get preventScroll() {
                return t.preventScroll;
              }
            });
          }, v = (x, S) => {
            {
              var p = (C) => {
                de(C, {
                  get preventScroll() {
                    return t.preventScroll;
                  }
                });
              };
              lt(x, (C) => {
                t.forceMount || C(p);
              }, S);
            }
          };
          lt(g, (x) => {
            t.forceMount && t.enabled ? x(m) : x(v, false);
          });
        }
        var y = ht(g, 2);
        const A = T(() => t.enabled && r());
        qe(y, {
          get id() {
            return t.id;
          },
          get onOpenAutoFocus() {
            return t.onOpenAutoFocus;
          },
          get onCloseAutoFocus() {
            return t.onCloseAutoFocus;
          },
          get loop() {
            return t.loop;
          },
          get trapFocus() {
            return w(A);
          },
          get forceMount() {
            return t.forceMount;
          },
          focusScope: (S, p) => {
            let C = () => p?.().props;
            je(S, {
              get onEscapeKeydown() {
                return t.onEscapeKeydown;
              },
              get escapeKeydownBehavior() {
                return t.escapeKeydownBehavior;
              },
              get enabled() {
                return t.enabled;
              },
              children: (R, F) => {
                Ze(R, {
                  get id() {
                    return t.id;
                  },
                  get onInteractOutside() {
                    return t.onInteractOutside;
                  },
                  get onFocusOutside() {
                    return t.onFocusOutside;
                  },
                  get interactOutsideBehavior() {
                    return n();
                  },
                  get isValidEvent() {
                    return i();
                  },
                  get enabled() {
                    return t.enabled;
                  },
                  children: (E, L) => {
                    let B = () => L?.().props;
                    Qe(E, {
                      get id() {
                        return t.id;
                      },
                      get preventOverflowTextSelection() {
                        return t.preventOverflowTextSelection;
                      },
                      get onPointerDown() {
                        return t.onPointerDown;
                      },
                      get onPointerUp() {
                        return t.onPointerUp;
                      },
                      get enabled() {
                        return t.enabled;
                      },
                      children: (W, D) => {
                        var j = V(), U = k(j), z = Ne(() => ({
                          props: Ot(c, l(), B(), C(), {
                            style: {
                              pointerEvents: "auto"
                            }
                          }),
                          wrapperProps: h()
                        }));
                        J(U, () => t.popper ?? wt, () => w(z)), _(W, j);
                      },
                      $$slots: {
                        default: true
                      }
                    });
                  },
                  $$slots: {
                    default: true
                  }
                });
              },
              $$slots: {
                default: true
              }
            });
          },
          $$slots: {
            focusScope: true
          }
        }), _(d, u);
      },
      $$slots: {
        content: true
      }
    }), tt();
  }
  gi = function(e, t) {
    let n = b(t, "interactOutsideBehavior", 3, "close"), r = b(t, "trapFocus", 3, true), i = b(t, "isValidEvent", 3, () => false), o = b(t, "customAnchor", 3, null), s = b(t, "isStatic", 3, false), c = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "popper",
      "present",
      "onEscapeKeydown",
      "escapeKeydownBehavior",
      "preventOverflowTextSelection",
      "id",
      "onPointerDown",
      "onPointerUp",
      "side",
      "sideOffset",
      "align",
      "alignOffset",
      "arrowPadding",
      "avoidCollisions",
      "collisionBoundary",
      "collisionPadding",
      "sticky",
      "hideWhenDetached",
      "updatePositionStrategy",
      "strategy",
      "dir",
      "preventScroll",
      "wrapperId",
      "style",
      "onPlaced",
      "onInteractOutside",
      "onCloseAutoFocus",
      "onOpenAutoFocus",
      "onFocusOutside",
      "interactOutsideBehavior",
      "loop",
      "trapFocus",
      "isValidEvent",
      "customAnchor",
      "isStatic"
    ]);
    Je(e, Lt({
      get id() {
        return t.id;
      },
      get present() {
        return t.present;
      }
    }, () => c, {
      presence: (d) => {
        ke(d, Lt({
          get popper() {
            return t.popper;
          },
          get onEscapeKeydown() {
            return t.onEscapeKeydown;
          },
          get escapeKeydownBehavior() {
            return t.escapeKeydownBehavior;
          },
          get preventOverflowTextSelection() {
            return t.preventOverflowTextSelection;
          },
          get id() {
            return t.id;
          },
          get onPointerDown() {
            return t.onPointerDown;
          },
          get onPointerUp() {
            return t.onPointerUp;
          },
          get side() {
            return t.side;
          },
          get sideOffset() {
            return t.sideOffset;
          },
          get align() {
            return t.align;
          },
          get alignOffset() {
            return t.alignOffset;
          },
          get arrowPadding() {
            return t.arrowPadding;
          },
          get avoidCollisions() {
            return t.avoidCollisions;
          },
          get collisionBoundary() {
            return t.collisionBoundary;
          },
          get collisionPadding() {
            return t.collisionPadding;
          },
          get sticky() {
            return t.sticky;
          },
          get hideWhenDetached() {
            return t.hideWhenDetached;
          },
          get updatePositionStrategy() {
            return t.updatePositionStrategy;
          },
          get strategy() {
            return t.strategy;
          },
          get dir() {
            return t.dir;
          },
          get preventScroll() {
            return t.preventScroll;
          },
          get wrapperId() {
            return t.wrapperId;
          },
          get style() {
            return t.style;
          },
          get onPlaced() {
            return t.onPlaced;
          },
          get customAnchor() {
            return o();
          },
          get isStatic() {
            return s();
          },
          get enabled() {
            return t.present;
          },
          get onInteractOutside() {
            return t.onInteractOutside;
          },
          get onCloseAutoFocus() {
            return t.onCloseAutoFocus;
          },
          get onOpenAutoFocus() {
            return t.onOpenAutoFocus;
          },
          get interactOutsideBehavior() {
            return n();
          },
          get loop() {
            return t.loop;
          },
          get trapFocus() {
            return r();
          },
          get isValidEvent() {
            return i();
          },
          get onFocusOutside() {
            return t.onFocusOutside;
          },
          forceMount: false
        }, () => c));
      },
      $$slots: {
        presence: true
      }
    }));
  };
  hi = function(e, t) {
    let n = b(t, "interactOutsideBehavior", 3, "close"), r = b(t, "trapFocus", 3, true), i = b(t, "isValidEvent", 3, () => false), o = b(t, "customAnchor", 3, null), s = b(t, "isStatic", 3, false), c = gt(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "popper",
      "onEscapeKeydown",
      "escapeKeydownBehavior",
      "preventOverflowTextSelection",
      "id",
      "onPointerDown",
      "onPointerUp",
      "side",
      "sideOffset",
      "align",
      "alignOffset",
      "arrowPadding",
      "avoidCollisions",
      "collisionBoundary",
      "collisionPadding",
      "sticky",
      "hideWhenDetached",
      "updatePositionStrategy",
      "strategy",
      "dir",
      "preventScroll",
      "wrapperId",
      "style",
      "onPlaced",
      "onInteractOutside",
      "onCloseAutoFocus",
      "onOpenAutoFocus",
      "onFocusOutside",
      "interactOutsideBehavior",
      "loop",
      "trapFocus",
      "isValidEvent",
      "customAnchor",
      "isStatic",
      "enabled"
    ]);
    ke(e, Lt({
      get popper() {
        return t.popper;
      },
      get onEscapeKeydown() {
        return t.onEscapeKeydown;
      },
      get escapeKeydownBehavior() {
        return t.escapeKeydownBehavior;
      },
      get preventOverflowTextSelection() {
        return t.preventOverflowTextSelection;
      },
      get id() {
        return t.id;
      },
      get onPointerDown() {
        return t.onPointerDown;
      },
      get onPointerUp() {
        return t.onPointerUp;
      },
      get side() {
        return t.side;
      },
      get sideOffset() {
        return t.sideOffset;
      },
      get align() {
        return t.align;
      },
      get alignOffset() {
        return t.alignOffset;
      },
      get arrowPadding() {
        return t.arrowPadding;
      },
      get avoidCollisions() {
        return t.avoidCollisions;
      },
      get collisionBoundary() {
        return t.collisionBoundary;
      },
      get collisionPadding() {
        return t.collisionPadding;
      },
      get sticky() {
        return t.sticky;
      },
      get hideWhenDetached() {
        return t.hideWhenDetached;
      },
      get updatePositionStrategy() {
        return t.updatePositionStrategy;
      },
      get strategy() {
        return t.strategy;
      },
      get dir() {
        return t.dir;
      },
      get preventScroll() {
        return t.preventScroll;
      },
      get wrapperId() {
        return t.wrapperId;
      },
      get style() {
        return t.style;
      },
      get onPlaced() {
        return t.onPlaced;
      },
      get customAnchor() {
        return o();
      },
      get isStatic() {
        return s();
      },
      get enabled() {
        return t.enabled;
      },
      get onInteractOutside() {
        return t.onInteractOutside;
      },
      get onCloseAutoFocus() {
        return t.onCloseAutoFocus;
      },
      get onOpenAutoFocus() {
        return t.onOpenAutoFocus;
      },
      get interactOutsideBehavior() {
        return n();
      },
      get loop() {
        return t.loop;
      },
      get trapFocus() {
        return r();
      },
      get isValidEvent() {
        return i();
      },
      get onFocusOutside() {
        return t.onFocusOutside;
      }
    }, () => c, {
      forceMount: true
    }));
  };
  let Me, pe, nt, Fr;
  Tr = (e) => {
    const t = Array.from(e);
    let n = 0;
    return t.forEach((r) => n += r.charCodeAt(0)), n;
  };
  Me = (e, t) => Math.floor(e / Math.pow(10, t) % 10);
  pe = (e, t) => !(Me(e, t) % 2);
  nt = (e, t, n) => {
    let r = e % t;
    return n && Me(e, n) % 2 === 0 ? -r : r;
  };
  xe = (e, t, n) => t[e % n];
  Fr = (e) => {
    e.slice(0, 1) === "#" && (e = e.slice(1));
    var t = parseInt(e.substr(0, 2), 16), n = parseInt(e.substr(2, 2), 16), r = parseInt(e.substr(4, 2), 16), i = (t * 299 + n * 587 + r * 114) / 1e3;
    return i >= 128 ? "black" : "white";
  };
  function _r(e, t) {
    return e = Math.ceil(e), t = Math.floor(t), Math.floor(Math.random() * (t - e) + e);
  }
  Dr = () => [
    ...Array(8)
  ].map(() => _r(0, 255)).toString();
  Mt = {
    colors: [
      "#92A1C6",
      "#146A7C",
      "#F0AB3D",
      "#C271B4",
      "#C20D90"
    ],
    name: "Clara Barton",
    square: false,
    size: 40
  };
  var Er = Qt('<path fill="none" stroke-linecap="round"></path>'), Br = Qt("<path></path>"), kr = Qt('<svg fill="none" xmlns="http://www.w3.org/2000/svg" data-testid="avatar-beam"><mask maskUnits="userSpaceOnUse"><rect fill="white"></rect></mask><g><rect></rect><rect x="0" y="0"></rect><g><!><rect stroke="none"></rect><rect stroke="none"></rect></g></g></svg>');
  Mr = function(e, t) {
    $(t, false);
    const n = 36;
    function r(C, R) {
      const F = Tr(C), I = R && R.length, E = xe(F, R, I), L = nt(F, 10, 1), B = L < 5 ? L + n / 9 : L, W = nt(F, 10, 2), D = W < 5 ? W + n / 9 : W;
      return {
        wrapperColor: E,
        faceColor: Fr(E),
        backgroundColor: xe(F + 13, R, I),
        wrapperTranslateX: B,
        wrapperTranslateY: D,
        wrapperRotate: nt(F, 360),
        wrapperScale: 1 + nt(F, n / 12) / 10,
        isMouthOpen: pe(F, 2),
        isCircle: pe(F, 1),
        eyeSpread: nt(F, 5),
        mouthSpread: nt(F, 3),
        faceRotate: nt(F, 10, 3),
        faceTranslateX: B > n / 6 ? B / 2 : nt(F, 8, 1),
        faceTranslateY: D > n / 6 ? D / 2 : nt(F, 7, 2)
      };
    }
    let i = b(t, "size", 24, () => Mt.size), o = b(t, "name", 24, () => Mt.name), s = b(t, "square", 24, () => Mt.square), c = b(t, "colors", 24, () => Mt.colors);
    const a = r(o(), c()), d = `mask__beam${Dr()}`;
    tn();
    var f = kr();
    P(f, "viewBox", "0 0 " + n + " " + n);
    var l = pt(f);
    P(l, "id", d), P(l, "x", 0), P(l, "y", 0), P(l, "width", n), P(l, "height", n);
    var h = pt(l);
    P(h, "width", n), P(h, "height", n), xt(l);
    var u = ht(l);
    P(u, "mask", `url(#${d ?? ""})`);
    var g = pt(u);
    P(g, "width", n), P(g, "height", n);
    var m = ht(g);
    P(m, "width", n), P(m, "height", n);
    var v = ht(m), y = pt(v);
    {
      var A = (C) => {
        var R = Er();
        ct(() => {
          P(R, "d", "M15 " + (19 + a.mouthSpread) + "c2 1 4 1 6 0"), P(R, "stroke", a.faceColor);
        }), _(C, R);
      }, x = (C) => {
        var R = Br();
        ct(() => {
          P(R, "d", "M13," + (19 + a.mouthSpread) + " a1,0.75 0 0,0 10,0"), P(R, "fill", a.faceColor);
        }), _(C, R);
      };
      lt(y, (C) => {
        a.isMouthOpen ? C(A) : C(x, false);
      });
    }
    var S = ht(y);
    P(S, "y", 14), P(S, "width", 1.5), P(S, "height", 2), P(S, "rx", 1);
    var p = ht(S);
    P(p, "y", 14), P(p, "width", 1.5), P(p, "height", 2), P(p, "rx", 1), xt(v), xt(u), xt(f), ct(() => {
      P(f, "width", i()), P(f, "height", i()), P(h, "rx", s() ? void 0 : n * 2), P(g, "fill", a.backgroundColor), P(m, "transform", "translate(" + a.wrapperTranslateX + " " + a.wrapperTranslateY + ") rotate(" + a.wrapperRotate + " " + n / 2 + " " + n / 2 + ") scale(" + a.wrapperScale + ")"), P(m, "fill", a.wrapperColor), P(m, "rx", a.isCircle ? n : n / 6), P(v, "transform", "translate(" + a.faceTranslateX + " " + a.faceTranslateY + ") rotate(" + a.faceRotate + " " + n / 2 + " " + n / 2 + ")"), P(S, "x", 14 - a.eyeSpread), P(S, "fill", a.faceColor), P(p, "x", 20 + a.eyeSpread), P(p, "fill", a.faceColor);
    }), _(e, f), tt();
  };
  var Ir = vt("<!> <!>", 1);
  mi = function(e, t) {
    var n = V(), r = k(n);
    const i = T(() => `w-8 aspect-square ${t.className}`);
    Yt(r, () => wn, (o, s) => {
      s(o, {
        get class() {
          return w(i);
        },
        children: (c, a) => {
          var d = Ir(), f = k(d);
          Yt(f, () => yn, (h, u) => {
            u(h, {
              get src() {
                return t.avatarUrl;
              },
              class: "rounded-full"
            });
          });
          var l = ht(f, 2);
          Yt(l, () => xn, (h, u) => {
            u(h, {
              children: (g, m) => {
                Mr(g, {
                  get name() {
                    return t.handle;
                  }
                });
              },
              $$slots: {
                default: true
              }
            });
          }), _(c, d);
        },
        $$slots: {
          default: true
        }
      });
    }), _(e, n);
  };
  function Lr(e, t, n, r) {
    var i, o, s = false, c = n.length >= 2, a = (g, m, v) => {
      if (i = m, c && (o = g), !s) {
        let y = t(g, m, v);
        if (t.length < 2) m(y);
        else return y;
      }
      s = false;
    }, d = en(e, a, r), f = !Array.isArray(e);
    function l(g) {
      var m = n(g, o);
      f ? (s = true, e.set(m)) : m.forEach((v, y) => {
        s = true, e[y].set(v);
      }), s = false;
    }
    var h = false;
    function u(g) {
      var m, v, y, A;
      if (h) {
        A = g(Xt(d)), i(A);
        return;
      }
      var x = d.subscribe((S) => {
        h ? m ? v = true : m = true : y = S;
      });
      A = g(y), h = true, i(A), x(), h = false, v && (A = Xt(d)), m && l(A);
    }
    return {
      subscribe: d.subscribe,
      set(g) {
        u(() => g);
      },
      update: u
    };
  }
  const Wr = 20, yt = Se([]), ce = Se(null), It = /* @__PURE__ */ new Map(), be = (e) => {
    if (It.has(e)) return;
    const t = setTimeout(() => {
      It.delete(e), Ie(e);
    }, 1e3);
    It.set(e, t);
  }, Vr = (e) => {
    const t = It.get(e);
    t && clearTimeout(t);
  };
  Nr = function(e, t = true) {
    t && e.id && Vr(e.id), yt.update((n) => n.map((r) => r.id === e.id ? {
      ...r,
      ...e
    } : r));
  };
  function Hr(e) {
    yt.update((t) => [
      e,
      ...t
    ].slice(0, Wr));
  }
  function zr(e) {
    Xt(yt).find((t) => t.id === e.id) ? Nr(e) : Hr(e);
  }
  function Kr(e) {
    yt.update((t) => (e ? be(e) : t.forEach((n) => {
      be(n.id);
    }), t.map((n) => n.id === e || e === void 0 ? {
      ...n,
      visible: false
    } : n)));
  }
  function Ie(e) {
    yt.update((t) => e === void 0 ? [] : t.filter((n) => n.id !== e));
  }
  wi = function(e) {
    ce.set(e);
  };
  vi = function(e) {
    let t;
    ce.update((n) => (t = e - (n || 0), null)), yt.update((n) => n.map((r) => ({
      ...r,
      pauseDuration: r.pauseDuration + t
    })));
  };
  const Yr = {
    blank: 4e3,
    error: 4e3,
    success: 2e3,
    loading: 1 / 0,
    custom: 4e3
  };
  yi = function(e = {}) {
    return {
      toasts: Lr(yt, (n) => n.map((r) => ({
        ...e,
        ...e[r.type],
        ...r,
        duration: r.duration || e[r.type]?.duration || e?.duration || Yr[r.type],
        style: [
          e.style,
          e[r.type]?.style,
          r.style
        ].join(";")
      })), (n) => n),
      pausedAt: ce
    };
  };
  let Ur, Ae, Xr, qr, Bt;
  Ur = (e) => typeof e == "function";
  Ae = (e, t) => Ur(e) ? e(t) : e;
  Xr = /* @__PURE__ */ (() => {
    let e = 0;
    return () => (e += 1, e.toString());
  })();
  pi = /* @__PURE__ */ (() => {
    let e;
    return () => {
      if (e === void 0 && typeof window < "u") {
        const t = matchMedia("(prefers-reduced-motion: reduce)");
        e = !t || t.matches;
      }
      return e;
    };
  })();
  qr = (e, t = "blank", n) => ({
    createdAt: Date.now(),
    visible: true,
    type: t,
    ariaProps: {
      role: "status",
      "aria-live": "polite"
    },
    message: e,
    pauseDuration: 0,
    icon: n?.icon,
    duration: n?.duration,
    iconTheme: n?.iconTheme,
    position: n?.position,
    props: n?.props,
    id: n?.id || Xr()
  });
  Bt = (e) => (t, n) => {
    const r = qr(t, e, n);
    return zr(r), r.id;
  };
  Z = (e, t) => Bt("blank")(e, t);
  Z.error = Bt("error");
  Z.success = Bt("success");
  Z.loading = Bt("loading");
  Z.custom = Bt("custom");
  Z.dismiss = (e) => {
    Kr(e);
  };
  Z.remove = (e) => Ie(e);
  Z.promise = (e, t, n) => {
    const r = Z.loading(t.loading, {
      ...n,
      ...n?.loading
    });
    return e.then((i) => (Z.success(Ae(t.success, i), {
      id: r,
      ...n,
      ...n?.success
    }), i)).catch((i) => {
      Z.error(Ae(t.error, i), {
        id: r,
        ...n,
        ...n?.error
      });
    }), e;
  };
});
export {
  mi as A,
  Mt as D,
  di as F,
  li as H,
  hi as P,
  __tla,
  gi as a,
  fi as b,
  Tr as c,
  xe as d,
  Nr as e,
  vi as f,
  Dr as g,
  wn as h,
  yn as i,
  xn as j,
  ui as k,
  Mr as l,
  pi as p,
  wi as s,
  Z as t,
  yi as u
};
