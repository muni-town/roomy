import "../chunks/NZTpNUN0.js";
import { h as $e, a0 as Oe, u as Ot, d as $, g as n, b as M, e as N, _ as tr, p as dt, f as S, a as ut, A as we, c as j, m as re, r as q, t as at, s as a, aT as er, n as ie } from "../chunks/BMAj9zKA.js";
import { s as ue, b as rr } from "../chunks/DzGbYseb.js";
import { i as K } from "../chunks/BA1UOs1h.js";
import { e as ge, i as Me } from "../chunks/BuDgEN05.js";
import { c as E, a as d, t as H, n as or, e as Ee } from "../chunks/pDBoOQRd.js";
import { s as ht } from "../chunks/k4NpJaFV.js";
import { c as Y } from "../chunks/BUHZJKy3.js";
import { b as Tt, s as e, d as Mt, a as xe, r as Ne } from "../chunks/DjDC-EQm.js";
import { o as ir, e as de } from "../chunks/BSdt-dIf.js";
import { n as kt, j as B, C as Re, a as fe, A as $t, z as ne, E as Pe, S as Ce, G as Ie, H as Le, I as Ke, J as Ve, K as ze, e as Fe, q as Ue, s as sr, L as nr, w as ae, t as Be, M as ar, d as lr, N as cr, O as hr, i as ve, m as ee, P as dr, B as It, b as Te, u as ur, __tla as __tla_0 } from "../chunks/BOaKtN8S.js";
import { p as tt } from "../chunks/Baj-A2iI.js";
import { a as gr, o as ye } from "../chunks/BqahWDdA.js";
import { p as Xt } from "../chunks/_G7J8Uer.js";
import { g as ke } from "../chunks/BNjT_JuR.js";
import { g as se, R as fr, __tla as __tla_1 } from "../chunks/BmvqXKNQ.js";
import { u as gt } from "../chunks/D7Oepc1u.js";
import { a as vr, __tla as __tla_2 } from "../chunks/BUkYaDtB.js";
import { I as te } from "../chunks/7tHZr1X2.js";
import { D as _e, __tla as __tla_3 } from "../chunks/CmGwp3aM.js";
import { H as pr, P as mr, a as _r, F as br, b as wr, D as ce, g as yr, c as xr, d as Sr, u as Nr, t as De, e as Pr, f as Cr, s as Ir, p as qe, A as Tr, h as kr, i as Dr, j as Ar, __tla as __tla_4 } from "../chunks/DfzdJtdG.js";
import { p as w, s as Ht, r as pe, a as Hr, b as Or } from "../chunks/D_-9kNr4.js";
import { a as Ae, T as Mr, __tla as __tla_5 } from "../chunks/DcnaqaBM.js";
import "../chunks/69_IOA4Y.js";
import { i as Er } from "../chunks/CrW2qrX9.js";
let zi, Vi;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })(),
  (() => {
    try {
      return __tla_1;
    } catch {
    }
  })(),
  (() => {
    try {
      return __tla_2;
    } catch {
    }
  })(),
  (() => {
    try {
      return __tla_3;
    } catch {
    }
  })(),
  (() => {
    try {
      return __tla_4;
    } catch {
    }
  })(),
  (() => {
    try {
      return __tla_5;
    } catch {
    }
  })()
]).then(async () => {
  class Se {
    #t = /* @__PURE__ */ new WeakMap();
    #e;
    #r;
    static entries = /* @__PURE__ */ new WeakMap();
    constructor(t) {
      this.#r = t;
    }
    observe(t, r) {
      var s = this.#t.get(t) || /* @__PURE__ */ new Set();
      return s.add(r), this.#t.set(t, s), this.#o().observe(t, this.#r), () => {
        var l = this.#t.get(t);
        l.delete(r), l.size === 0 && (this.#t.delete(t), this.#e.unobserve(t));
      };
    }
    #o() {
      return this.#e ?? (this.#e = new ResizeObserver((t) => {
        for (var r of t) {
          Se.entries.set(r.target, r);
          for (var s of this.#t.get(r.target) || []) s(r);
        }
      }));
    }
  }
  var Rr = new Se({
    box: "border-box"
  });
  function Lr(i, t, r) {
    var s = Rr.observe(i, () => r(i[t]));
    $e(() => (Oe(() => r(i[t])), s));
  }
  let Kr, Vr;
  Kr = [
    "abyss",
    "acid",
    "aqua",
    "autumn",
    "black",
    "bumblebee",
    "business",
    "caramellatte",
    "cmyk",
    "coffee",
    "corporate",
    "cupcake",
    "cyberpunk",
    "dark",
    "dim",
    "dracula",
    "emerald",
    "fantasy",
    "forest",
    "garden",
    "halloween",
    "lemonade",
    "light",
    "lofi",
    "luxury",
    "night",
    "nord",
    "pastel",
    "retro",
    "silk",
    "sunset",
    "synthwave",
    "valentine",
    "winter",
    "wireframe"
  ];
  Vr = false;
  Vi = Object.freeze(Object.defineProperty({
    __proto__: null,
    ssr: Vr
  }, Symbol.toStringTag, {
    value: "Module"
  }));
  function zr(i) {
    Ot(() => Oe(() => i()));
  }
  function Fr(i, t, r = true) {
    if (!(i.length === 0 || t < 0 || t >= i.length)) return i.length === 1 && t === 0 ? i[0] : t === i.length - 1 ? r ? i[0] : void 0 : i[t + 1];
  }
  function Ur(i, t, r = true) {
    if (!(i.length === 0 || t < 0 || t >= i.length)) return i.length === 1 && t === 0 ? i[0] : t === 0 ? r ? i[i.length - 1] : void 0 : i[t - 1];
  }
  function Br(i, t, r, s = true) {
    if (i.length === 0 || t < 0 || t >= i.length) return;
    let l = t + r;
    return s ? l = (l % i.length + i.length) % i.length : l = Math.max(0, Math.min(l, i.length - 1)), i[l];
  }
  function qr(i, t, r, s = true) {
    if (i.length === 0 || t < 0 || t >= i.length) return;
    let l = t - r;
    return s ? l = (l % i.length + i.length) % i.length : l = Math.max(0, Math.min(l, i.length - 1)), i[l];
  }
  function je(i, t, r) {
    const l = t.length > 1 && Array.from(t).every((o) => o === t[0]) ? t[0] : t, c = r ? i.indexOf(r) : -1;
    let u = jr(i, Math.max(c, 0));
    l.length === 1 && (u = u.filter((o) => o !== r));
    const g = u.find((o) => o?.toLowerCase().startsWith(l.toLowerCase()));
    return g !== r ? g : void 0;
  }
  function jr(i, t) {
    return i.map((r, s) => i[(t + s) % i.length]);
  }
  function We(i, t = 1e4, r = kt) {
    let s = null, l = $(tt(i));
    function c() {
      return window.setTimeout(() => {
        M(l, tt(i)), r(i);
      }, t);
    }
    return Ot(() => () => {
      s && clearTimeout(s);
    }), B.with(() => n(l), (u) => {
      M(l, tt(u)), r(u), s && clearTimeout(s), s = c();
    });
  }
  function Wr(i) {
    const t = We("", 1e3), r = i?.onMatch ?? ((u) => u.focus()), s = i?.getCurrentItem ?? (() => document.activeElement);
    function l(u, h) {
      if (!h.length) return;
      t.current = t.current + u;
      const g = s(), o = h.find((p) => p === g)?.textContent?.trim() ?? "", v = h.map((p) => p.textContent?.trim() ?? ""), b = je(v, t.current, o), f = h.find((p) => p.textContent?.trim() === b);
      return f && r(f), f;
    }
    function c() {
      t.current = "";
    }
    return {
      search: t,
      handleTypeaheadSearch: l,
      resetTypeahead: c
    };
  }
  function Gr(i) {
    const t = We("", 1e3);
    function r(l, c) {
      if (!i.enabled || !c.length) return;
      t.current = t.current + l;
      const u = i.getCurrentItem(), h = c.find((b) => b === u) ?? "", g = c.map((b) => b ?? ""), o = je(g, t.current, h), v = c.find((b) => b === o);
      return v && i.onMatch(v), v;
    }
    function s() {
      t.current = "";
    }
    return {
      search: t,
      handleTypeaheadSearch: r,
      resetTypeahead: s
    };
  }
  const Yr = [
    ne,
    Le,
    Ke
  ], Jr = [
    $t,
    Ve,
    ze
  ], Zr = [
    ...Yr,
    ...Jr
  ];
  class Ge {
    opts;
    #t = $(false);
    get touchedInput() {
      return n(this.#t);
    }
    set touchedInput(t) {
      M(this.#t, tt(t));
    }
    #e = $("");
    get inputValue() {
      return n(this.#e);
    }
    set inputValue(t) {
      M(this.#e, tt(t));
    }
    #r = $(null);
    get inputNode() {
      return n(this.#r);
    }
    set inputNode(t) {
      M(this.#r, tt(t));
    }
    #o = $(null);
    get contentNode() {
      return n(this.#o);
    }
    set contentNode(t) {
      M(this.#o, tt(t));
    }
    #i = $(null);
    get triggerNode() {
      return n(this.#i);
    }
    set triggerNode(t) {
      M(this.#i, tt(t));
    }
    #s = $("");
    get valueId() {
      return n(this.#s);
    }
    set valueId(t) {
      M(this.#s, tt(t));
    }
    #n = $(null);
    get highlightedNode() {
      return n(this.#n);
    }
    set highlightedNode(t) {
      M(this.#n, tt(t));
    }
    #a = N(() => this.highlightedNode ? this.highlightedNode.getAttribute("data-value") : null);
    get highlightedValue() {
      return n(this.#a);
    }
    #l = N(() => {
      if (this.highlightedNode) return this.highlightedNode.id;
    });
    get highlightedId() {
      return n(this.#l);
    }
    #c = N(() => this.highlightedNode ? this.highlightedNode.getAttribute("data-label") : null);
    get highlightedLabel() {
      return n(this.#c);
    }
    isUsingKeyboard = false;
    isCombobox = false;
    bitsAttrs;
    constructor(t) {
      this.opts = t, this.isCombobox = t.isCombobox, this.bitsAttrs = uo(this), tr(() => {
        this.opts.open.current || this.setHighlightedNode(null);
      });
    }
    setHighlightedNode(t, r = false) {
      this.highlightedNode = t, t && (this.isUsingKeyboard || r) && t.scrollIntoView({
        block: "nearest"
      });
    }
    getCandidateNodes() {
      const t = this.contentNode;
      return t ? Array.from(t.querySelectorAll(`[${this.bitsAttrs.item}]:not([data-disabled])`)) : [];
    }
    setHighlightedToFirstCandidate() {
      this.setHighlightedNode(null);
      const t = this.getCandidateNodes();
      t.length && this.setHighlightedNode(t[0]);
    }
    getNodeByValue(t) {
      return this.getCandidateNodes().find((s) => s.dataset.value === t) ?? null;
    }
    setOpen(t) {
      this.opts.open.current = t;
    }
    toggleOpen() {
      this.opts.open.current = !this.opts.open.current;
    }
    handleOpen() {
      this.setOpen(true);
    }
    handleClose() {
      this.setHighlightedNode(null), this.setOpen(false);
    }
    toggleMenu() {
      this.toggleOpen();
    }
  }
  class Qr extends Ge {
    opts;
    isMulti = false;
    #t = N(() => this.opts.value.current !== "");
    get hasValue() {
      return n(this.#t);
    }
    #e = N(() => this.opts.items.current.length ? this.opts.items.current.find((r) => r.value === this.opts.value.current)?.label ?? "" : "");
    get currentLabel() {
      return n(this.#e);
    }
    #r = N(() => this.opts.items.current.length ? this.opts.items.current.filter((r) => !r.disabled).map((r) => r.label) : []);
    get candidateLabels() {
      return n(this.#r);
    }
    #o = N(() => !(this.isMulti || this.opts.items.current.length === 0));
    get dataTypeaheadEnabled() {
      return n(this.#o);
    }
    constructor(t) {
      super(t), this.opts = t, Ot(() => {
        !this.opts.open.current && this.highlightedNode && this.setHighlightedNode(null);
      }), ae(() => this.opts.open.current, () => {
        this.opts.open.current && this.setInitialHighlightedNode();
      });
    }
    includesItem(t) {
      return this.opts.value.current === t;
    }
    toggleItem(t, r = t) {
      this.opts.value.current = this.includesItem(t) ? "" : t, this.inputValue = r;
    }
    setInitialHighlightedNode() {
      Be(() => {
        if (this.highlightedNode && document.contains(this.highlightedNode)) return;
        if (this.opts.value.current !== "") {
          const r = this.getNodeByValue(this.opts.value.current);
          if (r) {
            this.setHighlightedNode(r, true);
            return;
          }
        }
        const t = this.getCandidateNodes()[0];
        t && this.setHighlightedNode(t, true);
      });
    }
  }
  class Xr extends Ge {
    opts;
    isMulti = true;
    #t = N(() => this.opts.value.current.length > 0);
    get hasValue() {
      return n(this.#t);
    }
    constructor(t) {
      super(t), this.opts = t, Ot(() => {
        !this.opts.open.current && this.highlightedNode && this.setHighlightedNode(null);
      }), ae(() => this.opts.open.current, () => {
        this.opts.open.current && this.setInitialHighlightedNode();
      });
    }
    includesItem(t) {
      return this.opts.value.current.includes(t);
    }
    toggleItem(t, r = t) {
      this.includesItem(t) ? this.opts.value.current = this.opts.value.current.filter((s) => s !== t) : this.opts.value.current = [
        ...this.opts.value.current,
        t
      ], this.inputValue = r;
    }
    setInitialHighlightedNode() {
      Be(() => {
        if (this.highlightedNode && document.contains(this.highlightedNode)) return;
        if (this.opts.value.current.length && this.opts.value.current[0] !== "") {
          const r = this.getNodeByValue(this.opts.value.current[0]);
          if (r) {
            this.setHighlightedNode(r, true);
            return;
          }
        }
        const t = this.getCandidateNodes()[0];
        t && this.setHighlightedNode(t, true);
      });
    }
  }
  class $r {
    opts;
    root;
    #t;
    #e;
    constructor(t, r) {
      this.opts = t, this.root = r, fe({
        ...t,
        onRefChange: (s) => {
          this.root.triggerNode = s;
        }
      }), this.#t = Wr({
        getCurrentItem: () => this.root.highlightedNode,
        onMatch: (s) => {
          this.root.setHighlightedNode(s);
        }
      }), this.#e = Gr({
        getCurrentItem: () => this.root.isMulti ? "" : this.root.currentLabel,
        onMatch: (s) => {
          if (this.root.isMulti || !this.root.opts.items.current) return;
          const l = this.root.opts.items.current.find((c) => c.label === s);
          l && (this.root.opts.value.current = l.value);
        },
        enabled: !this.root.isMulti && this.root.dataTypeaheadEnabled
      }), this.onkeydown = this.onkeydown.bind(this), this.onpointerdown = this.onpointerdown.bind(this), this.onpointerup = this.onpointerup.bind(this), this.onclick = this.onclick.bind(this);
    }
    #r() {
      this.root.opts.open.current = true, this.#e.resetTypeahead(), this.#t.resetTypeahead();
    }
    #o(t) {
      this.#r();
    }
    onkeydown(t) {
      if (this.root.isUsingKeyboard = true, (t.key === $t || t.key === ne) && t.preventDefault(), !this.root.opts.open.current) {
        if (t.key === Pe || t.key === Ce || t.key === ne || t.key === $t) t.preventDefault(), this.root.handleOpen();
        else if (!this.root.isMulti && this.root.dataTypeaheadEnabled) {
          this.#e.handleTypeaheadSearch(t.key, this.root.candidateLabels);
          return;
        }
        if (this.root.hasValue) return;
        const c = this.root.getCandidateNodes();
        if (!c.length) return;
        if (t.key === ne) {
          const u = c[0];
          this.root.setHighlightedNode(u);
        } else if (t.key === $t) {
          const u = c[c.length - 1];
          this.root.setHighlightedNode(u);
        }
        return;
      }
      if (t.key === Ie) {
        this.root.handleClose();
        return;
      }
      if ((t.key === Pe || t.key === Ce) && !t.isComposing) {
        t.preventDefault();
        const c = this.root.highlightedValue === this.root.opts.value.current;
        if (!this.root.opts.allowDeselect.current && c && !this.root.isMulti) {
          this.root.handleClose();
          return;
        }
        if (this.root.highlightedValue !== null && this.root.toggleItem(this.root.highlightedValue, this.root.highlightedLabel ?? void 0), !this.root.isMulti && !c) {
          this.root.handleClose();
          return;
        }
      }
      if (t.key === $t && t.altKey && this.root.handleClose(), Zr.includes(t.key)) {
        t.preventDefault();
        const c = this.root.getCandidateNodes(), u = this.root.highlightedNode, h = u ? c.indexOf(u) : -1, g = this.root.opts.loop.current;
        let o;
        if (t.key === ne ? o = Fr(c, h, g) : t.key === $t ? o = Ur(c, h, g) : t.key === Ve ? o = Br(c, h, 10, g) : t.key === Le ? o = qr(c, h, 10, g) : t.key === Ke ? o = c[0] : t.key === ze && (o = c[c.length - 1]), !o) return;
        this.root.setHighlightedNode(o);
        return;
      }
      const r = t.ctrlKey || t.altKey || t.metaKey, s = t.key.length === 1;
      if (t.code === "Space") return;
      const l = this.root.getCandidateNodes();
      if (t.key !== Ie) {
        if (!r && s) {
          this.#t.handleTypeaheadSearch(t.key, l);
          return;
        }
        this.root.highlightedNode || this.root.setHighlightedToFirstCandidate();
      }
    }
    onclick(t) {
      t.currentTarget.focus();
    }
    onpointerdown(t) {
      if (this.root.opts.disabled.current) return;
      if (t.pointerType === "touch") return t.preventDefault();
      const r = t.target;
      r?.hasPointerCapture(t.pointerId) && r?.releasePointerCapture(t.pointerId), t.button === 0 && t.ctrlKey === false && (this.root.opts.open.current === false ? this.#o(t) : this.root.handleClose());
    }
    onpointerup(t) {
      t.preventDefault(), t.pointerType === "touch" && (this.root.opts.open.current === false ? this.#o(t) : this.root.handleClose());
    }
    #i = N(() => ({
      id: this.opts.id.current,
      disabled: this.root.opts.disabled.current ? true : void 0,
      "aria-haspopup": "listbox",
      "aria-expanded": sr(this.root.opts.open.current),
      "aria-activedescendant": this.root.highlightedId,
      "data-state": Ue(this.root.opts.open.current),
      "data-disabled": Fe(this.root.opts.disabled.current),
      "data-placeholder": this.root.hasValue ? void 0 : "",
      [this.root.bitsAttrs.trigger]: "",
      onpointerdown: this.onpointerdown,
      onkeydown: this.onkeydown,
      onclick: this.onclick,
      onpointerup: this.onpointerup
    }));
    get props() {
      return n(this.#i);
    }
  }
  class to {
    opts;
    root;
    #t = $(null);
    get viewportNode() {
      return n(this.#t);
    }
    set viewportNode(t) {
      M(this.#t, tt(t));
    }
    #e = $(false);
    get isPositioned() {
      return n(this.#e);
    }
    set isPositioned(t) {
      M(this.#e, tt(t));
    }
    constructor(t, r) {
      this.opts = t, this.root = r, fe({
        ...t,
        onRefChange: (s) => {
          this.root.contentNode = s;
        },
        deps: () => this.root.opts.open.current
      }), nr(() => {
        this.root.contentNode = null, this.isPositioned = false;
      }), ae(() => this.root.opts.open.current, () => {
        this.root.opts.open.current || (this.isPositioned = false);
      }), this.onpointermove = this.onpointermove.bind(this);
    }
    onpointermove(t) {
      this.root.isUsingKeyboard = false;
    }
    #r = N(() => {
      const t = this.root.isCombobox ? "--bits-combobox" : "--bits-select";
      return {
        [`${t}-content-transform-origin`]: "var(--bits-floating-transform-origin)",
        [`${t}-content-available-width`]: "var(--bits-floating-available-width)",
        [`${t}-content-available-height`]: "var(--bits-floating-available-height)",
        [`${t}-anchor-width`]: " var(--bits-floating-anchor-width)",
        [`${t}-anchor-height`]: "var(--bits-floating-anchor-height)"
      };
    });
    onInteractOutside = (t) => {
      if (t.target === this.root.triggerNode || t.target === this.root.inputNode) {
        t.preventDefault();
        return;
      }
      this.opts.onInteractOutside.current(t), !t.defaultPrevented && this.root.handleClose();
    };
    onEscapeKeydown = (t) => {
      this.opts.onEscapeKeydown.current(t), !t.defaultPrevented && this.root.handleClose();
    };
    onOpenAutoFocus = (t) => {
      t.preventDefault();
    };
    onCloseAutoFocus = (t) => {
      t.preventDefault();
    };
    #o = N(() => ({
      open: this.root.opts.open.current
    }));
    get snippetProps() {
      return n(this.#o);
    }
    #i = N(() => ({
      id: this.opts.id.current,
      role: "listbox",
      "aria-multiselectable": this.root.isMulti ? "true" : void 0,
      "data-state": Ue(this.root.opts.open.current),
      [this.root.bitsAttrs.content]: "",
      style: {
        display: "flex",
        flexDirection: "column",
        outline: "none",
        boxSizing: "border-box",
        pointerEvents: "auto",
        ...n(this.#r)
      },
      onpointermove: this.onpointermove
    }));
    get props() {
      return n(this.#i);
    }
    popperProps = {
      onInteractOutside: this.onInteractOutside,
      onEscapeKeydown: this.onEscapeKeydown,
      onOpenAutoFocus: this.onOpenAutoFocus,
      onCloseAutoFocus: this.onCloseAutoFocus,
      trapFocus: false,
      loop: false,
      onPlaced: () => {
        this.isPositioned = true;
      }
    };
  }
  class eo {
    opts;
    root;
    #t = N(() => this.root.includesItem(this.opts.value.current));
    get isSelected() {
      return n(this.#t);
    }
    #e = N(() => this.root.highlightedValue === this.opts.value.current);
    get isHighlighted() {
      return n(this.#e);
    }
    prevHighlighted = new cr(() => this.isHighlighted);
    #r = $(false);
    get mounted() {
      return n(this.#r);
    }
    set mounted(t) {
      M(this.#r, tt(t));
    }
    constructor(t, r) {
      this.opts = t, this.root = r, fe({
        ...t,
        deps: () => this.mounted
      }), ae([
        () => this.isHighlighted,
        () => this.prevHighlighted.current
      ], () => {
        this.isHighlighted ? this.opts.onHighlight.current() : this.prevHighlighted.current && this.opts.onUnhighlight.current();
      }), ae(() => this.mounted, () => {
        this.mounted && this.root.setInitialHighlightedNode();
      }), this.onpointerdown = this.onpointerdown.bind(this), this.onpointerup = this.onpointerup.bind(this), this.onpointermove = this.onpointermove.bind(this);
    }
    handleSelect() {
      if (this.opts.disabled.current) return;
      const t = this.opts.value.current === this.root.opts.value.current;
      if (!this.root.opts.allowDeselect.current && t && !this.root.isMulti) {
        this.root.handleClose();
        return;
      }
      this.root.toggleItem(this.opts.value.current, this.opts.label.current), !this.root.isMulti && !t && this.root.handleClose();
    }
    #o = N(() => ({
      selected: this.isSelected,
      highlighted: this.isHighlighted
    }));
    get snippetProps() {
      return n(this.#o);
    }
    onpointerdown(t) {
      t.preventDefault();
    }
    onpointerup(t) {
      if (!(t.defaultPrevented || !this.opts.ref.current)) {
        if (t.pointerType === "touch" && !hr) {
          ir(this.opts.ref.current, "click", () => {
            this.handleSelect(), this.root.setHighlightedNode(this.opts.ref.current);
          }, {
            once: true
          });
          return;
        }
        t.preventDefault(), this.handleSelect(), t.pointerType === "touch" && this.root.setHighlightedNode(this.opts.ref.current);
      }
    }
    onpointermove(t) {
      t.pointerType !== "touch" && this.root.highlightedNode !== this.opts.ref.current && this.root.setHighlightedNode(this.opts.ref.current);
    }
    #i = N(() => ({
      id: this.opts.id.current,
      role: "option",
      "aria-selected": this.root.includesItem(this.opts.value.current) ? "true" : void 0,
      "data-value": this.opts.value.current,
      "data-disabled": Fe(this.opts.disabled.current),
      "data-highlighted": this.root.highlightedValue === this.opts.value.current ? "" : void 0,
      "data-selected": this.root.includesItem(this.opts.value.current) ? "" : void 0,
      "data-label": this.opts.label.current,
      [this.root.bitsAttrs.item]: "",
      onpointermove: this.onpointermove,
      onpointerdown: this.onpointerdown,
      onpointerup: this.onpointerup
    }));
    get props() {
      return n(this.#i);
    }
  }
  class ro {
    opts;
    root;
    #t = N(() => this.root.opts.name.current !== "");
    get shouldRender() {
      return n(this.#t);
    }
    constructor(t, r) {
      this.opts = t, this.root = r, this.onfocus = this.onfocus.bind(this);
    }
    onfocus(t) {
      t.preventDefault(), this.root.isCombobox ? this.root.inputNode?.focus() : this.root.triggerNode?.focus();
    }
    #e = N(() => ({
      disabled: lr(this.root.opts.disabled.current),
      required: ar(this.root.opts.required.current),
      name: this.root.opts.name.current,
      value: this.opts.value.current,
      onfocus: this.onfocus
    }));
    get props() {
      return n(this.#e);
    }
  }
  class oo {
    opts;
    content;
    root;
    #t = $(0);
    get prevScrollTop() {
      return n(this.#t);
    }
    set prevScrollTop(t) {
      M(this.#t, tt(t));
    }
    constructor(t, r) {
      this.opts = t, this.content = r, this.root = r.root, fe({
        ...t,
        onRefChange: (s) => {
          this.content.viewportNode = s;
        },
        deps: () => this.root.opts.open.current
      });
    }
    #e = N(() => ({
      id: this.opts.id.current,
      role: "presentation",
      [this.root.bitsAttrs.viewport]: "",
      style: {
        position: "relative",
        flex: 1,
        overflow: "auto"
      }
    }));
    get props() {
      return n(this.#e);
    }
  }
  const le = new Re("Select.Root | Combobox.Root"), Ye = new Re("Select.Content | Combobox.Content");
  function io(i) {
    const { type: t, ...r } = i, s = t === "single" ? new Qr(r) : new Xr(r);
    return le.set(s);
  }
  function so(i) {
    return Ye.set(new to(i, le.get()));
  }
  function no(i) {
    return new $r(i, le.get());
  }
  function ao(i) {
    return new eo(i, le.get());
  }
  function lo(i) {
    return new oo(i, Ye.get());
  }
  function co(i) {
    return new ro(i, le.get());
  }
  const ho = [
    "trigger",
    "content",
    "item",
    "viewport",
    "scroll-up-button",
    "scroll-down-button",
    "group",
    "group-label",
    "separator",
    "arrow",
    "input",
    "content-wrapper",
    "item-text",
    "value"
  ];
  function uo(i) {
    const t = i.isCombobox, r = {};
    for (const s of ho) r[s] = t ? `data-combobox-${s}` : `data-select-${s}`;
    return r;
  }
  function He(i, t) {
    dt(t, true);
    let r = w(t, "value", 15, "");
    const s = co({
      value: B.with(() => r())
    });
    var l = E(), c = S(l);
    {
      var u = (h) => {
        pr(h, Ht(() => s.props, {
          get value() {
            return r();
          },
          set value(g) {
            r(g);
          }
        }));
      };
      K(c, (h) => {
        s.shouldRender && h(u);
      });
    }
    d(i, l), ut();
  }
  var go = H("<div><div><!></div></div>"), fo = H("<div><div><!></div></div>");
  function vo(i, t) {
    dt(t, true);
    let r = w(t, "id", 19, ve), s = w(t, "ref", 15, null), l = w(t, "forceMount", 3, false), c = w(t, "side", 3, "bottom"), u = w(t, "onInteractOutside", 3, kt), h = w(t, "onEscapeKeydown", 3, kt), g = w(t, "preventScroll", 3, false), o = pe(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "forceMount",
      "side",
      "onInteractOutside",
      "onEscapeKeydown",
      "children",
      "child",
      "preventScroll"
    ]);
    const v = so({
      id: B.with(() => r()),
      ref: B.with(() => s(), (m) => s(m)),
      onInteractOutside: B.with(() => u()),
      onEscapeKeydown: B.with(() => h())
    }), b = N(() => ee(o, v.props));
    var f = E(), p = S(f);
    {
      var C = (m) => {
        mr(m, Ht(() => n(b), () => v.popperProps, {
          get side() {
            return c();
          },
          get enabled() {
            return v.root.opts.open.current;
          },
          get id() {
            return r();
          },
          get preventScroll() {
            return g();
          },
          forceMount: true,
          popper: (x, _) => {
            let F = () => _?.().props, U = () => _?.().wrapperProps;
            var W = E();
            const rt = N(() => ee(F(), {
              style: v.props.style
            }));
            var et = S(W);
            {
              var st = (ot) => {
                var D = E(), T = S(D), I = we(() => ({
                  props: n(rt),
                  wrapperProps: U(),
                  ...v.snippetProps
                }));
                ht(T, () => t.child, () => n(I)), d(ot, D);
              }, J = (ot) => {
                var D = go();
                let T;
                var I = j(D);
                let k;
                var A = j(I);
                ht(A, () => t.children ?? re), q(I), q(D), at(() => {
                  T = Tt(D, T, {
                    ...U()
                  }), k = Tt(I, k, {
                    ...n(rt)
                  });
                }), d(ot, D);
              };
              K(et, (ot) => {
                t.child ? ot(st) : ot(J, false);
              });
            }
            d(x, W);
          },
          $$slots: {
            popper: true
          }
        }));
      }, P = (m, y) => {
        {
          var x = (_) => {
            _r(_, Ht(() => n(b), () => v.popperProps, {
              get side() {
                return c();
              },
              get present() {
                return v.root.opts.open.current;
              },
              get id() {
                return r();
              },
              get preventScroll() {
                return g();
              },
              forceMount: false,
              popper: (U, W) => {
                let rt = () => W?.().props, et = () => W?.().wrapperProps;
                var st = E();
                const J = N(() => ee(rt(), {
                  style: v.props.style
                }));
                var ot = S(st);
                {
                  var D = (I) => {
                    var k = E(), A = S(k), O = we(() => ({
                      props: n(J),
                      wrapperProps: et(),
                      ...v.snippetProps
                    }));
                    ht(A, () => t.child, () => n(O)), d(I, k);
                  }, T = (I) => {
                    var k = fo();
                    let A;
                    var O = j(k);
                    let V;
                    var R = j(O);
                    ht(R, () => t.children ?? re), q(O), q(k), at(() => {
                      A = Tt(k, A, {
                        ...et()
                      }), V = Tt(O, V, {
                        ...n(J)
                      });
                    }), d(I, k);
                  };
                  K(ot, (I) => {
                    t.child ? I(D) : I(T, false);
                  });
                }
                d(U, st);
              },
              $$slots: {
                popper: true
              }
            }));
          };
          K(m, (_) => {
            l() || _(x);
          }, y);
        }
      };
      K(p, (m) => {
        l() ? m(C) : m(P, false);
      });
    }
    d(i, f), ut();
  }
  function po(i, t) {
    dt(t, true);
    let r = w(t, "mounted", 15, false), s = w(t, "onMountedChange", 3, kt);
    zr(() => (r(true), s()(true), () => {
      r(false), s()(false);
    })), ut();
  }
  var mo = H("<div><!></div>"), _o = H("<!> <!>", 1);
  function bo(i, t) {
    dt(t, true);
    let r = w(t, "id", 19, ve), s = w(t, "ref", 15, null), l = w(t, "label", 19, () => t.value), c = w(t, "disabled", 3, false), u = w(t, "onHighlight", 3, kt), h = w(t, "onUnhighlight", 3, kt), g = pe(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "value",
      "label",
      "disabled",
      "children",
      "child",
      "onHighlight",
      "onUnhighlight"
    ]);
    const o = ao({
      id: B.with(() => r()),
      ref: B.with(() => s(), (m) => s(m)),
      value: B.with(() => t.value),
      disabled: B.with(() => c()),
      label: B.with(() => l()),
      onHighlight: B.with(() => u()),
      onUnhighlight: B.with(() => h())
    }), v = N(() => ee(g, o.props));
    var b = _o(), f = S(b);
    {
      var p = (m) => {
        var y = E(), x = S(y), _ = we(() => ({
          props: n(v),
          ...o.snippetProps
        }));
        ht(x, () => t.child, () => n(_)), d(m, y);
      }, C = (m) => {
        var y = mo();
        let x;
        var _ = j(y);
        ht(_, () => t.children ?? re, () => o.snippetProps), q(y), at(() => x = Tt(y, x, {
          ...n(v)
        })), d(m, y);
      };
      K(f, (m) => {
        t.child ? m(p) : m(C, false);
      });
    }
    var P = a(f, 2);
    po(P, {
      get mounted() {
        return o.mounted;
      },
      set mounted(m) {
        o.mounted = m;
      }
    }), d(i, b), ut();
  }
  var wo = H("<div><!></div>");
  function yo(i, t) {
    dt(t, true);
    let r = w(t, "id", 19, ve), s = w(t, "ref", 15, null), l = pe(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "children",
      "child"
    ]);
    const c = lo({
      id: B.with(() => r()),
      ref: B.with(() => s(), (b) => s(b))
    }), u = N(() => ee(l, c.props));
    var h = E(), g = S(h);
    {
      var o = (b) => {
        var f = E(), p = S(f);
        ht(p, () => t.child, () => ({
          props: n(u)
        })), d(b, f);
      }, v = (b) => {
        var f = wo();
        let p;
        var C = j(f);
        ht(C, () => t.children ?? re), q(f), at(() => p = Tt(f, p, {
          ...n(u)
        })), d(b, f);
      };
      K(g, (b) => {
        t.child ? b(o) : b(v, false);
      });
    }
    d(i, h), ut();
  }
  var xo = H("<!> <!>", 1);
  function So(i, t) {
    dt(t, true);
    let r = w(t, "value", 15), s = w(t, "onValueChange", 3, kt), l = w(t, "name", 3, ""), c = w(t, "disabled", 3, false), u = w(t, "open", 15, false), h = w(t, "onOpenChange", 3, kt), g = w(t, "loop", 3, false), o = w(t, "scrollAlignment", 3, "nearest"), v = w(t, "required", 3, false), b = w(t, "items", 19, () => []), f = w(t, "allowDeselect", 3, false);
    if (r() === void 0) {
      const _ = t.type === "single" ? "" : [];
      r(_);
    }
    const p = io({
      type: t.type,
      value: B.with(() => r(), (_) => {
        r(_), s()(_);
      }),
      disabled: B.with(() => c()),
      required: B.with(() => v()),
      open: B.with(() => u(), (_) => {
        u(_), h()(_);
      }),
      loop: B.with(() => g()),
      scrollAlignment: B.with(() => o()),
      name: B.with(() => l()),
      isCombobox: false,
      items: B.with(() => b()),
      allowDeselect: B.with(() => f())
    });
    var C = xo(), P = S(C);
    br(P, {
      children: (_, F) => {
        var U = E(), W = S(U);
        ht(W, () => t.children ?? re), d(_, U);
      },
      $$slots: {
        default: true
      }
    });
    var m = a(P, 2);
    {
      var y = (_) => {
        var F = E(), U = S(F);
        {
          var W = (rt) => {
            var et = E(), st = S(et);
            ge(st, 17, () => p.opts.value.current, Me, (J, ot) => {
              He(J, {
                get value() {
                  return n(ot);
                }
              });
            }), d(rt, et);
          };
          K(U, (rt) => {
            p.opts.value.current.length && rt(W);
          });
        }
        d(_, F);
      }, x = (_) => {
        He(_, {
          get value() {
            return p.opts.value.current;
          },
          set value(F) {
            p.opts.value.current = F;
          }
        });
      };
      K(m, (_) => {
        Array.isArray(p.opts.value.current) ? _(y) : _(x, false);
      });
    }
    d(i, C), ut();
  }
  var No = H("<button><!></button>");
  function Po(i, t) {
    dt(t, true);
    let r = w(t, "id", 19, ve), s = w(t, "ref", 15, null), l = w(t, "type", 3, "button"), c = pe(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "child",
      "children",
      "type"
    ]);
    const u = no({
      id: B.with(() => r()),
      ref: B.with(() => s(), (v) => s(v))
    }), h = N(() => ee(c, u.props, {
      type: l()
    }));
    var g = E(), o = S(g);
    Y(o, () => wr, (v, b) => {
      b(v, {
        get id() {
          return r();
        },
        children: (f, p) => {
          var C = E(), P = S(C);
          {
            var m = (x) => {
              var _ = E(), F = S(_);
              ht(F, () => t.child, () => ({
                props: n(h)
              })), d(x, _);
            }, y = (x) => {
              var _ = No();
              let F;
              var U = j(_);
              ht(U, () => t.children ?? re), q(_), at(() => F = Tt(_, F, {
                ...n(h)
              })), d(x, _);
            };
            K(P, (x) => {
              t.child ? x(m) : x(y, false);
            });
          }
          d(f, C);
        },
        $$slots: {
          default: true
        }
      });
    }), d(i, g), ut();
  }
  var Co = or('<svg fill="none" xmlns="http://www.w3.org/2000/svg" data-testid="avatar-pixel"><mask maskUnits="userSpaceOnUse"><rect fill="white"></rect></mask><g><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect><rect></rect></g></svg>');
  function Io(i, t) {
    dt(t, false);
    const r = 64, s = 80;
    function l(Je, me) {
      const Ze = xr(Je), Qe = me && me.length;
      return Array.from({
        length: r
      }, (gi, Xe) => ({
        color: Sr(Ze % (Xe + 13), me, Qe)
      }));
    }
    let c = w(t, "size", 24, () => ce.size), u = w(t, "name", 24, () => ce.name), h = w(t, "square", 24, () => ce.square), g = w(t, "colors", 24, () => ce.colors);
    const o = l(u(), g()), v = `mask0${yr()}`;
    Er();
    var b = Co();
    e(b, "viewBox", "0 0 " + s + " " + s);
    var f = j(b);
    e(f, "id", v), e(f, "x", 0), e(f, "y", 0), e(f, "width", s), e(f, "height", s), Mt(f, "", {}, {
      "mask-type": "alpha"
    });
    var p = j(f);
    e(p, "width", s), e(p, "height", s), q(f);
    var C = a(f);
    e(C, "mask", `url(#${v ?? ""})`);
    var P = j(C);
    e(P, "width", 10), e(P, "height", 10);
    var m = a(P);
    e(m, "x", 20), e(m, "width", 10), e(m, "height", 10);
    var y = a(m);
    e(y, "x", 40), e(y, "width", 10), e(y, "height", 10);
    var x = a(y);
    e(x, "x", 60), e(x, "width", 10), e(x, "height", 10);
    var _ = a(x);
    e(_, "x", 10), e(_, "width", 10), e(_, "height", 10);
    var F = a(_);
    e(F, "x", 30), e(F, "width", 10), e(F, "height", 10);
    var U = a(F);
    e(U, "x", 50), e(U, "width", 10), e(U, "height", 10);
    var W = a(U);
    e(W, "x", 70), e(W, "width", 10), e(W, "height", 10);
    var rt = a(W);
    e(rt, "y", 10), e(rt, "width", 10), e(rt, "height", 10);
    var et = a(rt);
    e(et, "y", 20), e(et, "width", 10), e(et, "height", 10);
    var st = a(et);
    e(st, "y", 30), e(st, "width", 10), e(st, "height", 10);
    var J = a(st);
    e(J, "y", 40), e(J, "width", 10), e(J, "height", 10);
    var ot = a(J);
    e(ot, "y", 50), e(ot, "width", 10), e(ot, "height", 10);
    var D = a(ot);
    e(D, "y", 60), e(D, "width", 10), e(D, "height", 10);
    var T = a(D);
    e(T, "y", 70), e(T, "width", 10), e(T, "height", 10);
    var I = a(T);
    e(I, "x", 20), e(I, "y", 10), e(I, "width", 10), e(I, "height", 10);
    var k = a(I);
    e(k, "x", 20), e(k, "y", 20), e(k, "width", 10), e(k, "height", 10);
    var A = a(k);
    e(A, "x", 20), e(A, "y", 30), e(A, "width", 10), e(A, "height", 10);
    var O = a(A);
    e(O, "x", 20), e(O, "y", 40), e(O, "width", 10), e(O, "height", 10);
    var V = a(O);
    e(V, "x", 20), e(V, "y", 50), e(V, "width", 10), e(V, "height", 10);
    var R = a(V);
    e(R, "x", 20), e(R, "y", 60), e(R, "width", 10), e(R, "height", 10);
    var L = a(R);
    e(L, "x", 20), e(L, "y", 70), e(L, "width", 10), e(L, "height", 10);
    var G = a(L);
    e(G, "x", 40), e(G, "y", 10), e(G, "width", 10), e(G, "height", 10);
    var X = a(G);
    e(X, "x", 40), e(X, "y", 20), e(X, "width", 10), e(X, "height", 10);
    var Z = a(X);
    e(Z, "x", 40), e(Z, "y", 30), e(Z, "width", 10), e(Z, "height", 10);
    var it = a(Z);
    e(it, "x", 40), e(it, "y", 40), e(it, "width", 10), e(it, "height", 10);
    var Q = a(it);
    e(Q, "x", 40), e(Q, "y", 50), e(Q, "width", 10), e(Q, "height", 10);
    var z = a(Q);
    e(z, "x", 40), e(z, "y", 60), e(z, "width", 10), e(z, "height", 10);
    var nt = a(z);
    e(nt, "x", 40), e(nt, "y", 70), e(nt, "width", 10), e(nt, "height", 10);
    var ct = a(nt);
    e(ct, "x", 60), e(ct, "y", 10), e(ct, "width", 10), e(ct, "height", 10);
    var vt = a(ct);
    e(vt, "x", 60), e(vt, "y", 20), e(vt, "width", 10), e(vt, "height", 10);
    var lt = a(vt);
    e(lt, "x", 60), e(lt, "y", 30), e(lt, "width", 10), e(lt, "height", 10);
    var wt = a(lt);
    e(wt, "x", 60), e(wt, "y", 40), e(wt, "width", 10), e(wt, "height", 10);
    var pt = a(wt);
    e(pt, "x", 60), e(pt, "y", 50), e(pt, "width", 10), e(pt, "height", 10);
    var ft = a(pt);
    e(ft, "x", 60), e(ft, "y", 60), e(ft, "width", 10), e(ft, "height", 10);
    var mt = a(ft);
    e(mt, "x", 60), e(mt, "y", 70), e(mt, "width", 10), e(mt, "height", 10);
    var St = a(mt);
    e(St, "x", 10), e(St, "y", 10), e(St, "width", 10), e(St, "height", 10);
    var Nt = a(St);
    e(Nt, "x", 10), e(Nt, "y", 20), e(Nt, "width", 10), e(Nt, "height", 10);
    var Dt = a(Nt);
    e(Dt, "x", 10), e(Dt, "y", 30), e(Dt, "width", 10), e(Dt, "height", 10);
    var yt = a(Dt);
    e(yt, "x", 10), e(yt, "y", 40), e(yt, "width", 10), e(yt, "height", 10);
    var xt = a(yt);
    e(xt, "x", 10), e(xt, "y", 50), e(xt, "width", 10), e(xt, "height", 10);
    var Pt = a(xt);
    e(Pt, "x", 10), e(Pt, "y", 60), e(Pt, "width", 10), e(Pt, "height", 10);
    var _t = a(Pt);
    e(_t, "x", 10), e(_t, "y", 70), e(_t, "width", 10), e(_t, "height", 10);
    var bt = a(_t);
    e(bt, "x", 30), e(bt, "y", 10), e(bt, "width", 10), e(bt, "height", 10);
    var Ct = a(bt);
    e(Ct, "x", 30), e(Ct, "y", 20), e(Ct, "width", 10), e(Ct, "height", 10);
    var At = a(Ct);
    e(At, "x", 30), e(At, "y", 30), e(At, "width", 10), e(At, "height", 10);
    var Et = a(At);
    e(Et, "x", 30), e(Et, "y", 40), e(Et, "width", 10), e(Et, "height", 10);
    var Rt = a(Et);
    e(Rt, "x", 30), e(Rt, "y", 50), e(Rt, "width", 10), e(Rt, "height", 10);
    var Lt = a(Rt);
    e(Lt, "x", 30), e(Lt, "y", 60), e(Lt, "width", 10), e(Lt, "height", 10);
    var Kt = a(Lt);
    e(Kt, "x", 30), e(Kt, "y", 70), e(Kt, "width", 10), e(Kt, "height", 10);
    var Vt = a(Kt);
    e(Vt, "x", 50), e(Vt, "y", 10), e(Vt, "width", 10), e(Vt, "height", 10);
    var zt = a(Vt);
    e(zt, "x", 50), e(zt, "y", 20), e(zt, "width", 10), e(zt, "height", 10);
    var Ft = a(zt);
    e(Ft, "x", 50), e(Ft, "y", 30), e(Ft, "width", 10), e(Ft, "height", 10);
    var Ut = a(Ft);
    e(Ut, "x", 50), e(Ut, "y", 40), e(Ut, "width", 10), e(Ut, "height", 10);
    var Bt = a(Ut);
    e(Bt, "x", 50), e(Bt, "y", 50), e(Bt, "width", 10), e(Bt, "height", 10);
    var qt = a(Bt);
    e(qt, "x", 50), e(qt, "y", 60), e(qt, "width", 10), e(qt, "height", 10);
    var jt = a(qt);
    e(jt, "x", 50), e(jt, "y", 70), e(jt, "width", 10), e(jt, "height", 10);
    var Wt = a(jt);
    e(Wt, "x", 70), e(Wt, "y", 10), e(Wt, "width", 10), e(Wt, "height", 10);
    var Gt = a(Wt);
    e(Gt, "x", 70), e(Gt, "y", 20), e(Gt, "width", 10), e(Gt, "height", 10);
    var Yt = a(Gt);
    e(Yt, "x", 70), e(Yt, "y", 30), e(Yt, "width", 10), e(Yt, "height", 10);
    var Jt = a(Yt);
    e(Jt, "x", 70), e(Jt, "y", 40), e(Jt, "width", 10), e(Jt, "height", 10);
    var Zt = a(Jt);
    e(Zt, "x", 70), e(Zt, "y", 50), e(Zt, "width", 10), e(Zt, "height", 10);
    var Qt = a(Zt);
    e(Qt, "x", 70), e(Qt, "y", 60), e(Qt, "width", 10), e(Qt, "height", 10);
    var oe = a(Qt);
    e(oe, "x", 70), e(oe, "y", 70), e(oe, "width", 10), e(oe, "height", 10), q(C), q(b), at(() => {
      e(b, "width", c()), e(b, "height", c()), e(p, "rx", h() ? void 0 : s * 2), e(P, "fill", o[0].color), e(m, "fill", o[1].color), e(y, "fill", o[2].color), e(x, "fill", o[3].color), e(_, "fill", o[4].color), e(F, "fill", o[5].color), e(U, "fill", o[6].color), e(W, "fill", o[7].color), e(rt, "fill", o[8].color), e(et, "fill", o[9].color), e(st, "fill", o[10].color), e(J, "fill", o[11].color), e(ot, "fill", o[12].color), e(D, "fill", o[13].color), e(T, "fill", o[14].color), e(I, "fill", o[15].color), e(k, "fill", o[16].color), e(A, "fill", o[17].color), e(O, "fill", o[18].color), e(V, "fill", o[19].color), e(R, "fill", o[20].color), e(L, "fill", o[21].color), e(G, "fill", o[22].color), e(X, "fill", o[23].color), e(Z, "fill", o[24].color), e(it, "fill", o[25].color), e(Q, "fill", o[26].color), e(z, "fill", o[27].color), e(nt, "fill", o[28].color), e(ct, "fill", o[29].color), e(vt, "fill", o[30].color), e(lt, "fill", o[31].color), e(wt, "fill", o[32].color), e(pt, "fill", o[33].color), e(ft, "fill", o[34].color), e(mt, "fill", o[35].color), e(St, "fill", o[36].color), e(Nt, "fill", o[37].color), e(Dt, "fill", o[38].color), e(yt, "fill", o[39].color), e(xt, "fill", o[40].color), e(Pt, "fill", o[41].color), e(_t, "fill", o[42].color), e(bt, "fill", o[43].color), e(Ct, "fill", o[44].color), e(At, "fill", o[45].color), e(Et, "fill", o[46].color), e(Rt, "fill", o[47].color), e(Lt, "fill", o[48].color), e(Kt, "fill", o[49].color), e(Vt, "fill", o[50].color), e(zt, "fill", o[51].color), e(Ft, "fill", o[52].color), e(Ut, "fill", o[53].color), e(Bt, "fill", o[54].color), e(qt, "fill", o[55].color), e(jt, "fill", o[56].color), e(Wt, "fill", o[57].color), e(Gt, "fill", o[58].color), e(Yt, "fill", o[59].color), e(Jt, "fill", o[60].color), e(Zt, "fill", o[61].color), e(Qt, "fill", o[62].color), e(oe, "fill", o[63].color);
    }), d(i, b), ut();
  }
  function To(i, t, r) {
    const { reverseOrder: s, gutter: l = 8, defaultPosition: c } = r || {}, u = t.filter((v) => (v.position || c) === (i.position || c) && v.height), h = u.findIndex((v) => v.id === i.id), g = u.filter((v, b) => b < h && v.visible).length;
    return u.filter((v) => v.visible).slice(...s ? [
      g + 1
    ] : [
      0,
      g
    ]).reduce((v, b) => v + (b.height || 0) + l, 0);
  }
  const ko = {
    startPause() {
      Ir(Date.now());
    },
    endPause() {
      Cr(Date.now());
    },
    updateHeight: (i, t) => {
      Pr({
        id: i,
        height: t
      }, false);
    },
    calculateOffset: To
  };
  function Do(i) {
    const { toasts: t, pausedAt: r } = Nr(i), s = /* @__PURE__ */ new Map();
    let l;
    const c = [
      r.subscribe((u) => {
        if (u) {
          for (const [, h] of s) clearTimeout(h);
          s.clear();
        }
        l = u;
      }),
      t.subscribe((u) => {
        if (l) return;
        const h = Date.now();
        for (const g of u) {
          if (s.has(g.id) || g.duration === 1 / 0) continue;
          const o = (g.duration || 0) + g.pauseDuration - (h - g.createdAt);
          if (o < 0) return g.visible && De.dismiss(g.id), null;
          s.set(g.id, setTimeout(() => De.dismiss(g.id), o));
        }
      })
    ];
    return gr(() => {
      for (const u of c) u();
    }), {
      toasts: t,
      handlers: ko
    };
  }
  var Ao = H('<div class="svelte-11kvm4p"></div>');
  function Ho(i, t) {
    let r = w(t, "primary", 3, "#61d345"), s = w(t, "secondary", 3, "#fff");
    var l = Ao();
    let c;
    at(() => c = Mt(l, "", c, {
      "--primary": r(),
      "--secondary": s()
    })), d(i, l);
  }
  var Oo = H('<div class="svelte-1ee93ns"></div>');
  function Mo(i, t) {
    let r = w(t, "primary", 3, "#ff4b4b"), s = w(t, "secondary", 3, "#fff");
    var l = Oo();
    let c;
    at(() => c = Mt(l, "", c, {
      "--primary": r(),
      "--secondary": s()
    })), d(i, l);
  }
  var Eo = H('<div class="svelte-1j7dflg"></div>');
  function Ro(i, t) {
    let r = w(t, "primary", 3, "#616161"), s = w(t, "secondary", 3, "#e0e0e0");
    var l = Eo();
    let c;
    at(() => c = Mt(l, "", c, {
      "--primary": r(),
      "--secondary": s()
    })), d(i, l);
  }
  var Lo = H('<div class="animated svelte-1kgeier"> </div>'), Ko = H('<div class="status svelte-1kgeier"><!></div>'), Vo = H('<div class="indicator svelte-1kgeier"><!> <!></div>');
  function be(i, t) {
    let r = N(() => t.toast.type), s = N(() => t.toast.icon), l = N(() => t.toast.iconTheme);
    var c = E(), u = S(c);
    {
      var h = (o) => {
        var v = Lo(), b = j(v, true);
        q(v), at(() => ue(b, n(s))), d(o, v);
      }, g = (o, v) => {
        {
          var b = (p) => {
            var C = E();
            const P = N(() => n(s));
            var m = S(C);
            Y(m, () => n(P), (y, x) => {
              x(y, {});
            }), d(p, C);
          }, f = (p, C) => {
            {
              var P = (m) => {
                var y = Vo(), x = j(y);
                Ro(x, Ht(() => n(l)));
                var _ = a(x, 2);
                {
                  var F = (U) => {
                    var W = Ko(), rt = j(W);
                    {
                      var et = (J) => {
                        Mo(J, Ht(() => n(l)));
                      }, st = (J) => {
                        Ho(J, Ht(() => n(l)));
                      };
                      K(rt, (J) => {
                        n(r) === "error" ? J(et) : J(st, false);
                      });
                    }
                    q(W), d(U, W);
                  };
                  K(_, (U) => {
                    n(r) !== "loading" && U(F);
                  });
                }
                q(y), d(m, y);
              };
              K(p, (m) => {
                n(r) !== "blank" && m(P);
              }, C);
            }
          };
          K(o, (p) => {
            typeof n(s) < "u" ? p(b) : p(f, false);
          }, v);
        }
      };
      K(u, (o) => {
        typeof n(s) == "string" ? o(h) : o(g, false);
      });
    }
    d(i, c);
  }
  var zo = H("<div><!></div>");
  function he(i, t) {
    dt(t, true);
    var r = zo();
    let s;
    var l = j(r);
    {
      var c = (h) => {
        var g = Ee();
        at(() => ue(g, t.toast.message)), d(h, g);
      }, u = (h) => {
        var g = E();
        const o = N(() => t.toast.message);
        var v = S(g);
        Y(v, () => n(o), (b, f) => {
          f(b, Ht({
            get toast() {
              return t.toast;
            }
          }, () => t.toast.props));
        }), d(h, g);
      };
      K(l, (h) => {
        typeof t.toast.message == "string" ? h(c) : h(u, false);
      });
    }
    q(r), at(() => s = Tt(r, s, {
      class: "message",
      ...t.toast.ariaProps
    }, "svelte-1nauejd")), d(i, r), ut();
  }
  var Fo = H("<!> <!>", 1), Uo = H("<div><!></div>");
  function Bo(i, t) {
    dt(t, true);
    let r = w(t, "position", 3, void 0), s = w(t, "style", 3, ""), l = w(t, "Component", 3, void 0), c = N(() => (t.toast.position || r() || "top-center").includes("top") ? 1 : -1), u = N(() => {
      const [f, p] = qe() ? [
        "fadeIn",
        "fadeOut"
      ] : [
        "enter",
        "exit"
      ];
      return t.toast.visible ? f : p;
    });
    var h = Uo();
    let g;
    var o = j(h);
    {
      var v = (f) => {
        var p = E(), C = S(p);
        Y(C, l, (P, m) => {
          m(P, {
            icon: (_) => {
              be(_, {
                get toast() {
                  return t.toast;
                }
              });
            },
            message: (_) => {
              he(_, {
                get toast() {
                  return t.toast;
                }
              });
            },
            $$slots: {
              icon: true,
              message: true
            }
          });
        }), d(f, p);
      }, b = (f, p) => {
        {
          var C = (m) => {
            var y = E(), x = S(y);
            ht(x, () => t.children, () => ({
              ToastIcon: be,
              ToastMessage: he,
              toast: t.toast
            })), d(m, y);
          }, P = (m) => {
            var y = Fo(), x = S(y);
            be(x, {
              get toast() {
                return t.toast;
              }
            });
            var _ = a(x, 2);
            he(_, {
              get toast() {
                return t.toast;
              }
            }), d(m, y);
          };
          K(f, (m) => {
            t.children ? m(C) : m(P, false);
          }, p);
        }
      };
      K(o, (f) => {
        l() ? f(v) : f(b, false);
      });
    }
    q(h), at(() => {
      xe(h, 1, `base ${(t.toast.height ? n(u) : "transparent") ?? ""} ${t.toast.className || ""}`, "svelte-1c9srrs"), g = Mt(h, `${s() ?? ""}; ${t.toast.style ?? ""}`, g, {
        "--factor": n(c)
      });
    }), d(i, h), ut();
  }
  var qo = H("<div><!></div>");
  function jo(i, t) {
    dt(t, true);
    let r = $(void 0);
    ye(() => {
      n(r) !== void 0 && t.setHeight(n(r));
    });
    let s = N(() => t.toast.position?.includes("top") ? 0 : null), l = N(() => t.toast.position?.includes("bottom") ? 0 : null), c = N(() => t.toast.position?.includes("top") ? 1 : -1), u = N(() => t.toast.position?.includes("center") && "center" || (t.toast.position?.includes("right") || t.toast.position?.includes("end")) && "flex-end" || null);
    var h = qo();
    let g, o;
    var v = j(h);
    {
      var b = (p) => {
        he(p, {
          get toast() {
            return t.toast;
          }
        });
      }, f = (p, C) => {
        {
          var P = (y) => {
            var x = E(), _ = S(x);
            ht(_, () => t.children, () => ({
              toast: t.toast
            })), d(y, x);
          }, m = (y) => {
            Bo(y, {
              get toast() {
                return t.toast;
              },
              get position() {
                return t.toast.position;
              }
            });
          };
          K(p, (y) => {
            t.children ? y(P) : y(m, false);
          }, C);
        }
      };
      K(v, (p) => {
        t.toast.type === "custom" ? p(b) : p(f, false);
      });
    }
    q(h), at((p) => {
      g = xe(h, 1, "wrapper svelte-v01oml", null, g, p), o = Mt(h, "", o, {
        "--factor": n(c),
        "--offset": t.toast.offset,
        top: n(s),
        bottom: n(l),
        "justify-content": n(u)
      });
    }, [
      () => ({
        active: t.toast.visible,
        transition: !qe()
      })
    ]), Lr(h, "clientHeight", (p) => M(r, p)), d(i, h), ut();
  }
  var Wo = H('<div role="alert"></div>');
  function Go(i, t) {
    dt(t, true);
    const [r, s] = Hr(), l = () => Or(b, "$toasts", r);
    let c = w(t, "reverseOrder", 3, false), u = w(t, "position", 3, "top-center"), h = w(t, "toastOptions", 3, void 0), g = w(t, "gutter", 3, 8), o = w(t, "containerStyle", 3, void 0), v = w(t, "containerClassName", 3, void 0);
    const { toasts: b, handlers: f } = Do(h());
    let p = N(() => l().map((P) => ({
      ...P,
      position: P.position || u(),
      offset: f.calculateOffset(P, l(), {
        reverseOrder: c(),
        gutter: g(),
        defaultPosition: u()
      })
    })));
    var C = Wo();
    ge(C, 21, () => n(p), (P) => P.id, (P, m) => {
      jo(P, {
        get toast() {
          return n(m);
        },
        setHeight: (y) => f.updateHeight(n(m).id, y)
      });
    }), q(C), at(() => {
      xe(C, 1, `toaster ${v() || ""}`, "svelte-1phplh9"), Mt(C, o());
    }), de("mouseenter", C, function(...P) {
      f.startPause?.apply(this, P);
    }), de("mouseleave", C, function(...P) {
      f.endPause?.apply(this, P);
    }), d(i, C), ut(), s();
  }
  var Yo = H('<span class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center"> <!></span>'), Jo = H("<!> <!>", 1);
  function Zo(i, t) {
    dt(t, true);
    let r = $("");
    const s = Kr.map((h) => ({
      value: h,
      label: `${h[0].toUpperCase()}${h.slice(1)}`
    }));
    Ot(() => {
      if (typeof window < "u") {
        const h = window.localStorage.getItem("theme");
        h ? (document.documentElement.setAttribute("data-theme", h), M(r, tt(h))) : (window.localStorage.setItem("theme", "synthwave"), document.documentElement.setAttribute("data-theme", "synthwave"), M(r, "synthwave"));
      }
    });
    function l(h) {
      window.localStorage.setItem("theme", h), document.cookie = `theme=${h}; path=/`, document.documentElement.setAttribute("data-theme", h), M(r, tt(h));
    }
    var c = E(), u = S(c);
    Y(u, () => So, (h, g) => {
      g(h, {
        type: "single",
        items: s,
        onValueChange: l,
        children: (o, v) => {
          var b = Jo(), f = S(b);
          Y(f, () => Po, (C, P) => {
            P(C, {
              class: "btn btn-ghost hover:bg-base-200 cursor-pointer",
              children: (m, y) => {
                te(m, {
                  icon: "material-symbols:palette-outline",
                  class: "size-6"
                });
              },
              $$slots: {
                default: true
              }
            });
          });
          var p = a(f, 2);
          Y(p, () => dr, (C, P) => {
            P(C, {
              children: (m, y) => {
                var x = E(), _ = S(x);
                Y(_, () => vo, (F, U) => {
                  U(F, {
                    side: "right",
                    sideOffset: 8,
                    class: "w-fit h-48 bg-base-300 p-2 rounded",
                    children: (W, rt) => {
                      var et = E(), st = S(et);
                      Y(st, () => yo, (J, ot) => {
                        ot(J, {
                          children: (D, T) => {
                            var I = E(), k = S(I);
                            ge(k, 19, () => s, (A, O) => O + A.value, (A, O) => {
                              var V = E(), R = S(V);
                              Y(R, () => bo, (L, G) => {
                                G(L, {
                                  get value() {
                                    return n(O).value;
                                  },
                                  get label() {
                                    return n(O).label;
                                  },
                                  children: (Z, it) => {
                                    let Q = () => it?.().selected;
                                    var z = Yo(), nt = j(z), ct = a(nt);
                                    {
                                      var vt = (lt) => {
                                        te(lt, {
                                          icon: "material-symbols:check-rounded"
                                        });
                                      };
                                      K(ct, (lt) => {
                                        Q() && lt(vt);
                                      });
                                    }
                                    q(z), at(() => ue(nt, `${n(O).label ?? ""} `)), d(Z, z);
                                  },
                                  $$slots: {
                                    default: true
                                  }
                                });
                              }), d(A, V);
                            }), d(D, I);
                          },
                          $$slots: {
                            default: true
                          }
                        });
                      }), d(W, et);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), d(m, x);
              },
              $$slots: {
                default: true
              }
            });
          }), d(o, b);
        },
        $$slots: {
          default: true
        }
      });
    }), d(i, c), ut();
  }
  var Qo = H("<!> <!>", 1), Xo = H('<!> <div class="divider mt-0 mb-1"></div> <!>', 1), $o = H("<!> Create Space", 1), ti = H('<form class="flex flex-col gap-4"><input placeholder="Name" class="input w-full"> <!></form>'), ei = H('<span class="loading loading-spinner"></span>'), ri = H("<!> Delete Local Data", 1), oi = H('<span class="loading loading-spinner"></span>'), ii = H("<!> Delete Local and PDS Data", 1), si = H(`<div class="flex flex-col items-center gap-4"><p class="text-sm"><strong>Warning:</strong> This will delete the Roomy data from this device
            and from your AtProto PDS if you chose.</p> <p class="text-sm">Roomy is currently <em>extremely</em> experimental, so until it gets
            a little more stable it may be necessary to reset all of your data in
            order to fix a problem after an update of Roomy is published.</p> <!> <!></div>`), ni = H('<section class="flex flex-col gap-4"><!></section>'), ai = H('<p class="text-error"> </p>'), li = H('<span class="loading loading-spinner"></span>'), ci = H("<!> Login with Bluesky", 1), hi = H('<form class="flex flex-col gap-4"><!> <input placeholder="Handle (eg alice.bsky.social)" class="input w-full"> <!></form>'), di = H('<!> <div class="flex w-screen h-screen bg-base-100"><!> <aside class="w-fit col-span-2 flex flex-col justify-between px-4 py-8 items-center border-r-2 border-base-200"><!> <section class="menu gap-3"><!> <!> <!> <!> <!></section></aside> <!></div>', 1);
  zi = function(i, t) {
    dt(t, true);
    let r = $(""), s = $(false), l = $(!gt.session), c = $(""), u = $(false), h = $(false), g = N(() => se.catalog?.view.spaces.map((D) => D.id) || []), o = $("");
    Ot(() => {
      Xt.params.space ? M(o, tt(Xt.params.space)) : Xt.url.pathname === "/home" && M(o, "home");
    }), ye(async () => {
      await gt.init();
    }), ye(() => {
      Xt.params.did ? M(o, "dm") : Xt.params.space && M(o, tt(Xt.params.space));
    }), Ot(() => {
      gt.session && M(l, false);
    });
    async function v() {
      if (!n(c)) return;
      let D = ur();
      se.catalog && (se.catalog.change((T) => {
        T.spaces.push({
          id: D,
          knownMembers: []
        });
      }), setTimeout(() => {
        se.spaces[D].change((T) => {
          T.name = n(c), T.admins.push(gt.agent.assertDid);
        }), M(c, "");
      }, 0), M(h, false));
    }
    async function b(D) {
      M(u, true), D == "all" && gt.agent?.did && await new fr(gt.agent).removeRange([]), localStorage.clear(), indexedDB.databases().then((T) => {
        T.forEach((I) => {
          I.name && indexedDB.deleteDatabase(I.name);
        });
      }), window.location.reload();
    }
    let f = $("");
    async function p() {
      M(s, true);
      try {
        M(r, tt(vr(n(r)))), await gt.loginWithHandle(n(r));
      } catch (D) {
        console.error(D), M(f, tt(D.toString()));
      }
      M(s, false);
    }
    var C = di();
    rr((D) => {
      er.title = "Roomy";
    });
    var P = S(C);
    K(P, (D) => {
    });
    var m = a(P, 2), y = j(m);
    Go(y, {});
    var x = a(y, 2), _ = j(x);
    Y(_, () => Mr, (D, T) => {
      T(D, {
        type: "single",
        get value() {
          return n(o);
        },
        class: "flex flex-col gap-2 items-center",
        children: (I, k) => {
          var A = Xo(), O = S(A);
          Y(O, () => Ae, (R, L) => {
            L(R, {
              value: "home",
              onclick: () => ke("/home"),
              class: "btn btn-ghost size-16 data-[state=on]:border-accent",
              children: (G, X) => {
                te(G, {
                  icon: "iconamoon:home-fill",
                  "font-size": "2em"
                });
              },
              $$slots: {
                default: true
              }
            });
          });
          var V = a(O, 4);
          ge(V, 17, () => n(g), Me, (R, L) => {
            var G = E();
            const X = N(() => se.spaces[n(L)]);
            var Z = S(G);
            {
              var it = (Q) => {
                var z = E(), nt = S(z);
                Y(nt, () => Ae, (ct, vt) => {
                  vt(ct, {
                    onclick: () => ke(`/space/${n(L)}`),
                    get value() {
                      return n(L);
                    },
                    get title() {
                      return n(X).view.name;
                    },
                    class: "btn btn-ghost size-16 data-[state=on]:border-primary",
                    children: (lt, wt) => {
                      var pt = E(), ft = S(pt);
                      Y(ft, () => kr, (mt, St) => {
                        St(mt, {
                          children: (Nt, Dt) => {
                            var yt = Qo(), xt = S(yt);
                            Y(xt, () => Dr, (_t, bt) => {
                              bt(_t, {});
                            });
                            var Pt = a(xt, 2);
                            Y(Pt, () => Ar, (_t, bt) => {
                              bt(_t, {
                                children: (Ct, At) => {
                                  Io(Ct, {
                                    get name() {
                                      return n(L);
                                    }
                                  });
                                },
                                $$slots: {
                                  default: true
                                }
                              });
                            }), d(Nt, yt);
                          },
                          $$slots: {
                            default: true
                          }
                        });
                      }), d(lt, pt);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), d(Q, z);
              };
              K(Z, (Q) => {
                n(X) && Q(it);
              });
            }
            d(R, G);
          }), d(I, A);
        },
        $$slots: {
          default: true
        }
      });
    });
    var F = a(_, 2), U = j(F);
    Zo(U, {});
    var W = a(U, 2);
    _e(W, {
      title: "Create Space",
      description: "Create a new public chat space",
      get isDialogOpen() {
        return n(h);
      },
      set isDialogOpen(T) {
        M(h, tt(T));
      },
      dialogTrigger: (T) => {
        var I = E(), k = S(I);
        Y(k, () => It, (A, O) => {
          O(A, {
            title: "Create Space",
            class: "btn btn-ghost w-fit",
            children: (V, R) => {
              te(V, {
                icon: "basil:add-solid",
                "font-size": "2em"
              });
            },
            $$slots: {
              default: true
            }
          });
        }), d(T, I);
      },
      children: (T, I) => {
        var k = ti(), A = j(k);
        Ne(A);
        var O = a(A, 2);
        const V = N(() => !n(c));
        Y(O, () => It, (R, L) => {
          L(R, {
            get disabled() {
              return n(V);
            },
            class: "btn btn-primary",
            children: (G, X) => {
              var Z = $o(), it = S(Z);
              te(it, {
                icon: "basil:add-outline",
                "font-size": "1.8em"
              }), ie(), d(G, Z);
            },
            $$slots: {
              default: true
            }
          });
        }), q(k), de("submit", k, v), Te(A, () => n(c), (R) => M(c, R)), d(T, k);
      },
      $$slots: {
        dialogTrigger: true,
        default: true
      }
    });
    var rt = a(W, 2);
    _e(rt, {
      title: "Delete Data",
      dialogTrigger: (T) => {
        var I = E(), k = S(I);
        Y(k, () => It, (A, O) => {
          O(A, {
            class: "btn btn-ghost w-fit",
            children: (V, R) => {
              te(V, {
                icon: "ri:alarm-warning-fill",
                class: "text-2xl"
              });
            },
            $$slots: {
              default: true
            }
          });
        }), d(T, I);
      },
      children: (T, I) => {
        var k = si(), A = a(j(k), 4);
        Y(A, () => It, (V, R) => {
          R(V, {
            onclick: () => b("local"),
            class: "btn btn-error",
            get disabled() {
              return n(u);
            },
            children: (L, G) => {
              var X = ri(), Z = S(X);
              {
                var it = (Q) => {
                  var z = ei();
                  d(Q, z);
                };
                K(Z, (Q) => {
                  n(u) && Q(it);
                });
              }
              ie(), d(L, X);
            },
            $$slots: {
              default: true
            }
          });
        });
        var O = a(A, 2);
        Y(O, () => It, (V, R) => {
          R(V, {
            onclick: () => b("all"),
            class: "btn btn-error",
            get disabled() {
              return n(u);
            },
            children: (L, G) => {
              var X = ii(), Z = S(X);
              {
                var it = (Q) => {
                  var z = oi();
                  d(Q, z);
                };
                K(Z, (Q) => {
                  n(u) && Q(it);
                });
              }
              ie(), d(L, X);
            },
            $$slots: {
              default: true
            }
          });
        }), q(k), d(T, k);
      },
      $$slots: {
        dialogTrigger: true,
        default: true
      }
    });
    var et = a(rt, 2);
    K(et, (D) => {
    });
    var st = a(et, 2);
    const J = N(() => gt.session ? `Logged In As ${gt.profile.data?.handle}` : "Login with AT Protocol");
    _e(st, {
      get title() {
        return n(J);
      },
      get isDialogOpen() {
        return n(l);
      },
      set isDialogOpen(T) {
        M(l, tt(T));
      },
      dialogTrigger: (T) => {
        var I = E(), k = S(I);
        Y(k, () => It, (A, O) => {
          O(A, {
            class: "btn btn-ghost w-fit",
            children: (V, R) => {
              const L = N(() => gt.profile.data?.handle || ""), G = N(() => gt.profile.data?.avatar);
              Tr(V, {
                get handle() {
                  return n(L);
                },
                get avatarUrl() {
                  return n(G);
                }
              });
            },
            $$slots: {
              default: true
            }
          });
        }), d(T, I);
      },
      children: (T, I) => {
        var k = E(), A = S(k);
        {
          var O = (R) => {
            var L = ni(), G = j(L);
            Y(G, () => It, (X, Z) => {
              Z(X, {
                get onclick() {
                  return gt.logout;
                },
                class: "btn btn-error",
                children: (it, Q) => {
                  ie();
                  var z = Ee("Logout");
                  d(it, z);
                },
                $$slots: {
                  default: true
                }
              });
            }), q(L), d(R, L);
          }, V = (R) => {
            var L = hi(), G = j(L);
            {
              var X = (z) => {
                var nt = ai(), ct = j(nt, true);
                q(nt), at(() => ue(ct, n(f))), d(z, nt);
              };
              K(G, (z) => {
                n(f) && z(X);
              });
            }
            var Z = a(G, 2);
            Ne(Z);
            var it = a(Z, 2);
            const Q = N(() => n(s) || !n(r));
            Y(it, () => It, (z, nt) => {
              nt(z, {
                get disabled() {
                  return n(Q);
                },
                class: "btn btn-primary",
                children: (ct, vt) => {
                  var lt = ci(), wt = S(lt);
                  {
                    var pt = (ft) => {
                      var mt = li();
                      d(ft, mt);
                    };
                    K(wt, (ft) => {
                      n(s) && ft(pt);
                    });
                  }
                  ie(), d(ct, lt);
                },
                $$slots: {
                  default: true
                }
              });
            }), q(L), de("submit", L, p), Te(Z, () => n(r), (z) => M(r, z)), d(R, L);
          };
          K(A, (R) => {
            gt.session ? R(O) : R(V, false);
          });
        }
        d(T, k);
      },
      $$slots: {
        dialogTrigger: true,
        default: true
      }
    }), q(F), q(x);
    var ot = a(x, 2);
    ht(ot, () => t.children), q(m), d(i, C), ut();
  };
});
export {
  __tla,
  zi as component,
  Vi as universal
};
