import "./NZTpNUN0.js";
import { e as u, u as Q, b as S, g as e, d as W, p as C, f as P, a as R, c as x, m as A, r as D, t as E, A as X } from "./BMAj9zKA.js";
import { c as T, a as p, t as M } from "./pDBoOQRd.js";
import { i as O } from "./BA1UOs1h.js";
import { s as w } from "./k4NpJaFV.js";
import { b as V } from "./DjDC-EQm.js";
import { p as i, r as B } from "./D_-9kNr4.js";
import { C as Y, a as L, E as Z, S as $, g as tt, c as et, d as st, e as N, f as U, h as rt, i as j, n as ot, j as n, m as q, __tla as __tla_0 } from "./BOaKtN8S.js";
import { p as it } from "./Baj-A2iI.js";
let It, Gt;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  const at = "data-toggle-group-root", z = "data-toggle-group-item";
  class K {
    opts;
    rovingFocusGroup;
    constructor(t) {
      this.opts = t, this.rovingFocusGroup = rt({
        candidateAttr: z,
        rootNodeId: t.id,
        loop: t.loop,
        orientation: t.orientation
      }), L(t);
    }
    #t = u(() => ({
      id: this.opts.id.current,
      [at]: "",
      role: "group",
      "data-orientation": U(this.opts.orientation.current),
      "data-disabled": N(this.opts.disabled.current)
    }));
    get props() {
      return e(this.#t);
    }
  }
  class nt extends K {
    opts;
    isMulti = false;
    #t = u(() => this.opts.value.current !== "");
    get anyPressed() {
      return e(this.#t);
    }
    constructor(t) {
      super(t), this.opts = t;
    }
    includesItem(t) {
      return this.opts.value.current === t;
    }
    toggleItem(t, r) {
      this.includesItem(t) ? this.opts.value.current = "" : (this.opts.value.current = t, this.rovingFocusGroup.setCurrentTabStopId(r));
    }
  }
  class ut extends K {
    opts;
    isMulti = true;
    #t = u(() => this.opts.value.current.length > 0);
    get anyPressed() {
      return e(this.#t);
    }
    constructor(t) {
      super(t), this.opts = t;
    }
    includesItem(t) {
      return this.opts.value.current.includes(t);
    }
    toggleItem(t, r) {
      this.includesItem(t) ? this.opts.value.current = this.opts.value.current.filter((d) => d !== t) : (this.opts.value.current = [
        ...this.opts.value.current,
        t
      ], this.rovingFocusGroup.setCurrentTabStopId(r));
    }
  }
  class lt {
    opts;
    root;
    #t = u(() => this.opts.disabled.current || this.root.opts.disabled.current);
    constructor(t, r) {
      this.opts = t, this.root = r, L(t), Q(() => {
        this.root.opts.rovingFocus.current ? S(this.#e, it(this.root.rovingFocusGroup.getTabIndex(this.opts.ref.current))) : S(this.#e, 0);
      }), this.onclick = this.onclick.bind(this), this.onkeydown = this.onkeydown.bind(this);
    }
    #s() {
      e(this.#t) || this.root.toggleItem(this.opts.value.current, this.opts.id.current);
    }
    onclick(t) {
      e(this.#t) || this.root.toggleItem(this.opts.value.current, this.opts.id.current);
    }
    onkeydown(t) {
      if (!e(this.#t)) {
        if (t.key === Z || t.key === $) {
          t.preventDefault(), this.#s();
          return;
        }
        this.root.opts.rovingFocus.current && this.root.rovingFocusGroup.handleKeydown(this.opts.ref.current, t);
      }
    }
    #r = u(() => this.root.includesItem(this.opts.value.current));
    get isPressed() {
      return e(this.#r);
    }
    #o = u(() => this.root.isMulti ? void 0 : tt(this.isPressed, false));
    #i = u(() => this.root.isMulti ? et(this.isPressed) : void 0);
    #e = W(0);
    #a = u(() => ({
      pressed: this.isPressed
    }));
    get snippetProps() {
      return e(this.#a);
    }
    #n = u(() => ({
      id: this.opts.id.current,
      role: this.root.isMulti ? void 0 : "radio",
      tabindex: e(this.#e),
      "data-orientation": U(this.root.opts.orientation.current),
      "data-disabled": N(e(this.#t)),
      "data-state": dt(this.isPressed),
      "data-value": this.opts.value.current,
      "aria-pressed": e(this.#i),
      "aria-checked": e(this.#o),
      disabled: st(e(this.#t)),
      [z]: "",
      onclick: this.onclick,
      onkeydown: this.onkeydown
    }));
    get props() {
      return e(this.#n);
    }
  }
  function dt(s) {
    return s ? "on" : "off";
  }
  const H = new Y("ToggleGroup.Root");
  function ct(s) {
    const { type: t, ...r } = s, d = t === "single" ? new nt(r) : new ut(r);
    return H.set(d);
  }
  function ht(s) {
    return new lt(s, H.get());
  }
  var gt = M("<div><!></div>");
  It = function(s, t) {
    C(t, true);
    let r = i(t, "id", 19, j), d = i(t, "ref", 15, null), h = i(t, "value", 15), I = i(t, "onValueChange", 3, ot), G = i(t, "disabled", 3, false), f = i(t, "loop", 3, true), m = i(t, "orientation", 3, "horizontal"), b = i(t, "rovingFocus", 3, true), k = B(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "value",
      "onValueChange",
      "type",
      "disabled",
      "loop",
      "orientation",
      "rovingFocus",
      "child",
      "children"
    ]);
    if (h() === void 0) {
      const o = t.type === "single" ? "" : [];
      h(o);
    }
    const F = ct({
      id: n.with(() => r()),
      value: n.with(() => h(), (o) => {
        h(o), I()(o);
      }),
      disabled: n.with(() => G()),
      loop: n.with(() => f()),
      orientation: n.with(() => m()),
      rovingFocus: n.with(() => b()),
      type: t.type,
      ref: n.with(() => d(), (o) => d(o))
    }), _ = u(() => q(k, F.props));
    var a = T(), l = P(a);
    {
      var g = (o) => {
        var c = T(), y = P(c);
        w(y, () => t.child, () => ({
          props: e(_)
        })), p(o, c);
      }, v = (o) => {
        var c = gt();
        let y;
        var J = x(c);
        w(J, () => t.children ?? A), D(c), E(() => y = V(c, y, {
          ...e(_)
        })), p(o, c);
      };
      O(l, (o) => {
        t.child ? o(g) : o(v, false);
      });
    }
    p(s, a), R();
  };
  var pt = M("<button><!></button>");
  Gt = function(s, t) {
    C(t, true);
    let r = i(t, "ref", 15, null), d = i(t, "disabled", 3, false), h = i(t, "id", 19, j), I = i(t, "type", 3, "button"), G = B(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "children",
      "child",
      "ref",
      "value",
      "disabled",
      "id",
      "type"
    ]);
    const f = ht({
      id: n.with(() => h()),
      value: n.with(() => t.value),
      disabled: n.with(() => d() ?? false),
      ref: n.with(() => r(), (a) => r(a))
    }), m = u(() => q(G, f.props, {
      type: I()
    }));
    var b = T(), k = P(b);
    {
      var F = (a) => {
        var l = T(), g = P(l), v = X(() => ({
          props: e(m),
          ...f.snippetProps
        }));
        w(g, () => t.child, () => e(v)), p(a, l);
      }, _ = (a) => {
        var l = pt();
        let g;
        var v = x(l);
        w(v, () => t.children ?? A, () => f.snippetProps), D(l), E(() => g = V(l, g, {
          ...e(m)
        })), p(a, l);
      };
      O(k, (a) => {
        t.child ? a(F) : a(_, false);
      });
    }
    p(s, b), R();
  };
});
export {
  It as T,
  __tla,
  Gt as a
};
