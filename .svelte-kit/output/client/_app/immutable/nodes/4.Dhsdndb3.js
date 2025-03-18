import "../chunks/NZTpNUN0.js";
import { e as g, g as t, d as le, _ as Tt, b as O, p as Me, f as a, a as Fe, c as $, m as Ee, r as _, t as de, A as Ot, j as Ke, u as jt, s as y, n as Ne } from "../chunks/BMAj9zKA.js";
import { s as ke } from "../chunks/DzGbYseb.js";
import { i as Y } from "../chunks/BA1UOs1h.js";
import { e as Ue, i as Le } from "../chunks/BuDgEN05.js";
import { c as b, a as r, t as o, e as gt } from "../chunks/pDBoOQRd.js";
import { s as ue } from "../chunks/k4NpJaFV.js";
import { c as x } from "../chunks/BUHZJKy3.js";
import { b as Ve, a as Nt, c as kt, r as rt } from "../chunks/DjDC-EQm.js";
import { e as at } from "../chunks/BSdt-dIf.js";
import { g as Rt, o as Mt, t as st, __tla as __tla_0 } from "../chunks/C8D1QxlH.js";
import { C as xt, a as Ge, f as Be, e as Xe, q as Ye, S as Ft, E as Et, r as Vt, s as zt, w as Gt, t as Bt, h as qt, i as Re, n as Ht, j as E, m as qe, v as Jt, u as Qe, B as Te, b as it, __tla as __tla_1 } from "../chunks/BOaKtN8S.js";
import { b as Wt } from "../chunks/B9N9amIG.js";
import { p as ce } from "../chunks/Baj-A2iI.js";
import { I as be } from "../chunks/7tHZr1X2.js";
import { D as ot, __tla as __tla_2 } from "../chunks/CmGwp3aM.js";
import { p as ne } from "../chunks/_G7J8Uer.js";
import { g as _t, __tla as __tla_3 } from "../chunks/BmvqXKNQ.js";
import { g as nt } from "../chunks/BNjT_JuR.js";
import { u as bt } from "../chunks/D7Oepc1u.js";
import { i as Kt, __tla as __tla_4 } from "../chunks/BUkYaDtB.js";
import { p as j, r as He } from "../chunks/D_-9kNr4.js";
import { T as Ut, a as lt, __tla as __tla_5 } from "../chunks/DcnaqaBM.js";
let ha;
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
  const Lt = "data-accordion-root", wt = "data-accordion-trigger", Qt = "data-accordion-content", Xt = "data-accordion-item", Yt = "data-accordion-header";
  class $t {
    opts;
    rovingFocusGroup;
    constructor(e) {
      this.opts = e, Ge(this.opts), this.rovingFocusGroup = qt({
        rootNodeId: this.opts.id,
        candidateAttr: wt,
        loop: this.opts.loop,
        orientation: this.opts.orientation
      });
    }
    #e = g(() => ({
      id: this.opts.id.current,
      "data-orientation": Be(this.opts.orientation.current),
      "data-disabled": Xe(this.opts.disabled.current),
      [Lt]: ""
    }));
    get props() {
      return t(this.#e);
    }
  }
  class Zt extends $t {
    opts;
    isMulti = false;
    constructor(e) {
      super(e), this.opts = e, this.includesItem = this.includesItem.bind(this), this.toggleItem = this.toggleItem.bind(this);
    }
    includesItem(e) {
      return this.opts.value.current === e;
    }
    toggleItem(e) {
      this.opts.value.current = this.includesItem(e) ? "" : e;
    }
  }
  class er extends $t {
    #e;
    isMulti = true;
    constructor(e) {
      super(e), this.#e = e.value, this.includesItem = this.includesItem.bind(this), this.toggleItem = this.toggleItem.bind(this);
    }
    includesItem(e) {
      return this.#e.current.includes(e);
    }
    toggleItem(e) {
      this.includesItem(e) ? this.#e.current = this.#e.current.filter((h) => h !== e) : this.#e.current = [
        ...this.#e.current,
        e
      ];
    }
  }
  class tr {
    opts;
    root;
    #e = g(() => this.root.includesItem(this.opts.value.current));
    get isActive() {
      return t(this.#e);
    }
    #t = g(() => this.opts.disabled.current || this.root.opts.disabled.current);
    get isDisabled() {
      return t(this.#t);
    }
    constructor(e) {
      this.opts = e, this.root = e.rootState, this.updateValue = this.updateValue.bind(this), Ge({
        ...e,
        deps: () => this.isActive
      });
    }
    updateValue() {
      this.root.toggleItem(this.opts.value.current);
    }
    #r = g(() => ({
      id: this.opts.id.current,
      "data-state": Ye(this.isActive),
      "data-disabled": Xe(this.isDisabled),
      "data-orientation": Be(this.root.opts.orientation.current),
      [Xt]: ""
    }));
    get props() {
      return t(this.#r);
    }
  }
  class rr {
    opts;
    itemState;
    #e;
    #t = g(() => this.opts.disabled.current || this.itemState.opts.disabled.current || this.#e.opts.disabled.current);
    constructor(e, h) {
      this.opts = e, this.itemState = h, this.#e = h.root, this.onkeydown = this.onkeydown.bind(this), this.onclick = this.onclick.bind(this), Ge(e);
    }
    onclick(e) {
      if (!t(this.#t)) {
        if (e.button !== 0) return e.preventDefault();
        this.itemState.updateValue();
      }
    }
    onkeydown(e) {
      if (!t(this.#t)) {
        if (e.key === Ft || e.key === Et) {
          e.preventDefault(), this.itemState.updateValue();
          return;
        }
        this.#e.rovingFocusGroup.handleKeydown(this.opts.ref.current, e);
      }
    }
    #r = g(() => ({
      id: this.opts.id.current,
      disabled: t(this.#t),
      "aria-expanded": zt(this.itemState.isActive),
      "aria-disabled": Vt(t(this.#t)),
      "data-disabled": Xe(t(this.#t)),
      "data-state": Ye(this.itemState.isActive),
      "data-orientation": Be(this.#e.opts.orientation.current),
      [wt]: "",
      tabindex: 0,
      onclick: this.onclick,
      onkeydown: this.onkeydown
    }));
    get props() {
      return t(this.#r);
    }
  }
  class ar {
    opts;
    item;
    #e = void 0;
    #t = false;
    #r = le(0);
    #a = le(0);
    #s = g(() => this.opts.forceMount.current || this.item.isActive);
    get present() {
      return t(this.#s);
    }
    constructor(e, h) {
      this.opts = e, this.item = h, this.item = h, this.#t = this.item.isActive, Ge(e), Tt(() => {
        const w = requestAnimationFrame(() => {
          this.#t = false;
        });
        return () => {
          cancelAnimationFrame(w);
        };
      }), Gt([
        () => this.present,
        () => this.opts.ref.current
      ], ([w, p]) => {
        p && Bt(() => {
          if (!this.opts.ref.current) return;
          this.#e = this.#e || {
            transitionDuration: p.style.transitionDuration,
            animationName: p.style.animationName
          }, p.style.transitionDuration = "0s", p.style.animationName = "none";
          const f = p.getBoundingClientRect();
          if (O(this.#a, ce(f.height)), O(this.#r, ce(f.width)), !this.#t) {
            const { animationName: s, transitionDuration: A } = this.#e;
            p.style.transitionDuration = A, p.style.animationName = s;
          }
        });
      });
    }
    #i = g(() => ({
      open: this.item.isActive
    }));
    get snippetProps() {
      return t(this.#i);
    }
    #o = g(() => ({
      id: this.opts.id.current,
      "data-state": Ye(this.item.isActive),
      "data-disabled": Xe(this.item.isDisabled),
      "data-orientation": Be(this.item.root.opts.orientation.current),
      [Qt]: "",
      style: {
        "--bits-accordion-content-height": `${t(this.#a)}px`,
        "--bits-accordion-content-width": `${t(this.#r)}px`
      }
    }));
    get props() {
      return t(this.#o);
    }
  }
  class sr {
    opts;
    item;
    constructor(e, h) {
      this.opts = e, this.item = h, Ge(e);
    }
    #e = g(() => ({
      id: this.opts.id.current,
      role: "heading",
      "aria-level": this.opts.level.current,
      "data-heading-level": this.opts.level.current,
      "data-state": Ye(this.item.isActive),
      "data-orientation": Be(this.item.root.opts.orientation.current),
      [Yt]: ""
    }));
    get props() {
      return t(this.#e);
    }
  }
  const Ct = new xt("Accordion.Root"), Ze = new xt("Accordion.Item");
  function ir(n) {
    const { type: e, ...h } = n, w = e === "single" ? new Zt(h) : new er(h);
    return Ct.set(w);
  }
  function or(n) {
    const e = Ct.get();
    return Ze.set(new tr({
      ...n,
      rootState: e
    }));
  }
  function nr(n) {
    return new rr(n, Ze.get());
  }
  function lr(n) {
    return new ar(n, Ze.get());
  }
  function cr(n) {
    return new sr(n, Ze.get());
  }
  var dr = o("<div><!></div>");
  function yt(n, e) {
    Me(e, true);
    let h = j(e, "disabled", 3, false), w = j(e, "value", 15), p = j(e, "ref", 15, null), f = j(e, "id", 19, Re), s = j(e, "onValueChange", 3, Ht), A = j(e, "loop", 3, true), G = j(e, "orientation", 3, "vertical"), P = He(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "disabled",
      "children",
      "child",
      "type",
      "value",
      "ref",
      "id",
      "onValueChange",
      "loop",
      "orientation"
    ]);
    w() === void 0 && w(e.type === "single" ? "" : []);
    const D = ir({
      type: e.type,
      value: E.with(() => w(), (m) => {
        w(m), s()(m);
      }),
      id: E.with(() => f()),
      disabled: E.with(() => h()),
      loop: E.with(() => A()),
      orientation: E.with(() => G()),
      ref: E.with(() => p(), (m) => p(m))
    }), B = g(() => qe(P, D.props));
    var c = b(), l = a(c);
    {
      var v = (m) => {
        var i = b(), ve = a(i);
        ue(ve, () => e.child, () => ({
          props: t(B)
        })), r(m, i);
      }, V = (m) => {
        var i = dr();
        let ve;
        var De = $(i);
        ue(De, () => e.children ?? Ee), _(i), de(() => ve = Ve(i, ve, {
          ...t(B)
        })), r(m, i);
      };
      Y(l, (m) => {
        e.child ? m(v) : m(V, false);
      });
    }
    r(n, c), Fe();
  }
  var ur = o("<div><!></div>");
  function ct(n, e) {
    Me(e, true);
    let h = j(e, "id", 19, Re), w = j(e, "disabled", 3, false), p = j(e, "value", 19, Re), f = j(e, "ref", 15, null), s = He(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "disabled",
      "value",
      "children",
      "child",
      "ref"
    ]);
    const A = or({
      value: E.with(() => p()),
      disabled: E.with(() => w()),
      id: E.with(() => h()),
      ref: E.with(() => f(), (l) => f(l))
    }), G = g(() => qe(s, A.props));
    var P = b(), D = a(P);
    {
      var B = (l) => {
        var v = b(), V = a(v);
        ue(V, () => e.child, () => ({
          props: t(G)
        })), r(l, v);
      }, c = (l) => {
        var v = ur();
        let V;
        var m = $(v);
        ue(m, () => e.children ?? Ee), _(v), de(() => V = Ve(v, V, {
          ...t(G)
        })), r(l, v);
      };
      Y(D, (l) => {
        e.child ? l(B) : l(c, false);
      });
    }
    r(n, P), Fe();
  }
  var vr = o("<div><!></div>");
  function dt(n, e) {
    Me(e, true);
    let h = j(e, "id", 19, Re), w = j(e, "level", 3, 2), p = j(e, "ref", 15, null), f = He(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "level",
      "children",
      "child",
      "ref"
    ]);
    const s = cr({
      id: E.with(() => h()),
      level: E.with(() => w()),
      ref: E.with(() => p(), (c) => p(c))
    }), A = g(() => qe(f, s.props));
    var G = b(), P = a(G);
    {
      var D = (c) => {
        var l = b(), v = a(l);
        ue(v, () => e.child, () => ({
          props: t(A)
        })), r(c, l);
      }, B = (c) => {
        var l = vr();
        let v;
        var V = $(l);
        ue(V, () => e.children ?? Ee), _(l), de(() => v = Ve(l, v, {
          ...t(A)
        })), r(c, l);
      };
      Y(P, (c) => {
        e.child ? c(D) : c(B, false);
      });
    }
    r(n, G), Fe();
  }
  var hr = o("<button><!></button>");
  function ut(n, e) {
    Me(e, true);
    let h = j(e, "disabled", 3, false), w = j(e, "ref", 15, null), p = j(e, "id", 19, Re), f = He(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "disabled",
      "ref",
      "id",
      "children",
      "child"
    ]);
    const s = nr({
      disabled: E.with(() => h()),
      id: E.with(() => p()),
      ref: E.with(() => w(), (c) => w(c))
    }), A = g(() => qe(f, s.props));
    var G = b(), P = a(G);
    {
      var D = (c) => {
        var l = b(), v = a(l);
        ue(v, () => e.child, () => ({
          props: t(A)
        })), r(c, l);
      }, B = (c) => {
        var l = hr();
        let v;
        var V = $(l);
        ue(V, () => e.children ?? Ee), _(l), de(() => v = Ve(l, v, {
          type: "button",
          ...t(A)
        })), r(c, l);
      };
      Y(P, (c) => {
        e.child ? c(D) : c(B, false);
      });
    }
    r(n, G), Fe();
  }
  var pr = o("<div><!></div>");
  function vt(n, e) {
    Me(e, true);
    let h = j(e, "ref", 15, null), w = j(e, "id", 19, Re), p = j(e, "forceMount", 3, false), f = He(e, [
      "$$slots",
      "$$events",
      "$$legacy",
      "child",
      "ref",
      "id",
      "forceMount",
      "children"
    ]);
    const s = lr({
      forceMount: E.with(() => p()),
      id: E.with(() => w()),
      ref: E.with(() => h(), (A) => h(A))
    });
    Jt(n, {
      forceMount: true,
      get present() {
        return s.present;
      },
      get id() {
        return w();
      },
      presence: (G, P) => {
        let D = () => P?.().present;
        var B = b();
        const c = g(() => qe(f, s.props, {
          hidden: p() ? void 0 : !D().current
        }));
        var l = a(B);
        {
          var v = (m) => {
            var i = b(), ve = a(i), De = Ot(() => ({
              props: t(c),
              ...s.snippetProps
            }));
            ue(ve, () => e.child, () => t(De)), r(m, i);
          }, V = (m) => {
            var i = pr();
            let ve;
            var De = $(i);
            ue(De, () => e.children ?? Ee), _(i), de(() => ve = Ve(i, ve, {
              ...t(c)
            })), r(m, i);
          };
          Y(l, (m) => {
            e.child ? m(v) : m(V, false);
          });
        }
        r(G, B);
      },
      $$slots: {
        presence: true
      }
    }), Fe();
  }
  function fr(n) {
    const e = n - 1;
    return e * e * e + 1;
  }
  function ht(n, { delay: e = 0, duration: h = 400, easing: w = fr, axis: p = "y" } = {}) {
    const f = getComputedStyle(n), s = +f.opacity, A = p === "y" ? "height" : "width", G = parseFloat(f[A]), P = p === "y" ? [
      "top",
      "bottom"
    ] : [
      "left",
      "right"
    ], D = P.map((i) => `${i[0].toUpperCase()}${i.slice(1)}`), B = parseFloat(f[`padding${D[0]}`]), c = parseFloat(f[`padding${D[1]}`]), l = parseFloat(f[`margin${D[0]}`]), v = parseFloat(f[`margin${D[1]}`]), V = parseFloat(f[`border${D[0]}Width`]), m = parseFloat(f[`border${D[1]}Width`]);
    return {
      delay: e,
      duration: h,
      easing: w,
      css: (i) => `overflow: hidden;opacity: ${Math.min(i * 20, 1) * s};${A}: ${i * G}px;padding-${P[0]}: ${i * B}px;padding-${P[1]}: ${i * c}px;margin-${P[0]}: ${i * l}px;margin-${P[1]}: ${i * v}px;border-${P[0]}-width: ${i * V}px;border-${P[1]}-width: ${i * m}px;min-${A}: 0`
    };
  }
  var mr = o("<!> ", 1), gr = o('<form class="flex flex-col gap-4 w-full"><label class="input w-full"><span class="label">Name</span> <input placeholder="channel-name"></label> <!></form>'), _r = o("<!> <!>", 1), br = o('<h3 class="flex justify-start items-center gap-2 px-2"><!> </h3>'), yr = o("<div></div>"), xr = o("<!> <!>", 1), wr = o('<h3 class="flex justify-start items-center gap-2 px-2"><!> </h3>'), $r = o('<div class="flex flex-col gap-4"></div>'), Cr = o('<h3 class="flex justify-start items-center gap-2 px-2"><!> </h3>'), Ar = o('<div class="flex flex-col gap-4"></div>'), Pr = o("<!> Create Channel", 1), Dr = o("<option> </option>"), Sr = o("<!> Create Channel", 1), Ir = o('<form class="flex flex-col gap-4"><label class="input w-full"><span class="label">Name</span> <input placeholder="General"></label> <label class="select w-full"><span class="label">Category</span> <select><option>None</option><!></select></label> <!></form>'), Tr = o("<!> Create Category", 1), Or = o("<!> Create Category", 1), jr = o('<form class="flex flex-col gap-4"><label class="input w-full"><span class="label">Name</span> <input placeholder="Discussions"></label> <!></form>'), Nr = o('<menu class="menu p-0 w-full justify-between join join-vertical"><!> <!></menu>'), kr = o("<h3>Channels</h3> <!>", 1), Rr = o("<!> <!>", 1), Mr = o("<h3>Threads</h3> <!>", 1), Fr = o("<!> <!>", 1), Er = o('<div class="divider my-0"></div> <!>', 1), Vr = o("<!> <!>", 1), zr = o('<main class="flex flex-col gap-4 rounded-lg p-4 grow min-w-0 h-full overflow-clip bg-base-100"><!></main>'), Gr = o('<main class="absolute inset-0 flex flex-col gap-4 rounded-lg p-4 h-screen overflow-clip bg-base-100"><!></main>'), Br = o('<nav><h1 class="text-2xl font-extrabold text-base-content text-ellipsis"> </h1> <div class="divider my-0"></div> <!> <!></nav> <!>', 1), qr = o('<div class="flex flex-col justify-center items-center w-full"><!></div>');
  ha = function(n, e) {
    Me(e, true);
    const h = (u, d = Ee) => {
      var N = $r();
      Ue(N, 21, () => d().view.sidebarItems, Le, (ae, he) => {
        var Pe = b(), Se = a(Pe);
        {
          var Ie = (ye) => {
            var Ae = b();
            const C = g(() => d().view.categories[t(he).id]);
            var q = a(Ae);
            x(q, () => yt, (Q, Z) => {
              Z(Q, {
                type: "single",
                get value() {
                  return t(C).name;
                },
                children: (X, k) => {
                  var J = b(), S = a(J);
                  x(S, () => ct, (R, se) => {
                    se(R, {
                      get value() {
                        return t(C).name;
                      },
                      children: (ee, te) => {
                        var W = xr(), ie = a(W);
                        x(ie, () => dt, (M, K) => {
                          K(M, {
                            class: "flex justify-between",
                            children: (re, we) => {
                              var U = _r(), pe = a(U);
                              x(pe, () => ut, (oe, me) => {
                                me(oe, {
                                  class: "flex text-sm font-semibold gap-2 items-center cursor-pointer",
                                  children: (I, H) => {
                                    var T = mr(), F = a(T);
                                    be(F, {
                                      icon: "basil:folder-solid"
                                    });
                                    var z = y(F);
                                    de(() => ke(z, ` ${t(C).name ?? ""}`)), r(I, T);
                                  },
                                  $$slots: {
                                    default: true
                                  }
                                });
                              });
                              var $e = y(pe, 2);
                              {
                                var fe = (oe) => {
                                  ot(oe, {
                                    title: "Channel Settings",
                                    get isDialogOpen() {
                                      return t(et);
                                    },
                                    set isDialogOpen(I) {
                                      O(et, ce(I));
                                    },
                                    dialogTrigger: (I) => {
                                      var H = b(), T = a(H);
                                      x(T, () => Te, (F, z) => {
                                        z(F, {
                                          title: "Channel Settings",
                                          class: "cursor-pointer btn btn-ghost btn-circle",
                                          onclick: () => {
                                            O(pt, ce(t(he).id)), O(ze, ce(t(C).name));
                                          },
                                          children: (L, ge) => {
                                            be(L, {
                                              icon: "lucide:settings",
                                              class: "size-4"
                                            });
                                          },
                                          $$slots: {
                                            default: true
                                          }
                                        });
                                      }), r(I, H);
                                    },
                                    children: (I, H) => {
                                      var T = gr(), F = $(T), z = y($(F), 2);
                                      rt(z), _(F);
                                      var L = y(F, 2);
                                      const ge = g(() => !t(ze));
                                      x(L, () => Te, (_e, Ce) => {
                                        Ce(_e, {
                                          get disabled() {
                                            return t(ge);
                                          },
                                          class: "btn btn-primary",
                                          children: (je, Je) => {
                                            Ne();
                                            var We = gt("Save Category");
                                            r(je, We);
                                          },
                                          $$slots: {
                                            default: true
                                          }
                                        });
                                      }), _(T), at("submit", T, At), it(z, () => t(ze), (_e) => O(ze, _e)), r(I, T);
                                    },
                                    $$slots: {
                                      dialogTrigger: true,
                                      default: true
                                    }
                                  });
                                };
                                Y($e, (oe) => {
                                  t(D) && oe(fe);
                                });
                              }
                              r(re, U);
                            },
                            $$slots: {
                              default: true
                            }
                          });
                        });
                        var xe = y(ie, 2);
                        x(xe, () => vt, (M, K) => {
                          K(M, {
                            forceMount: true,
                            child: (we, U) => {
                              let pe = () => U?.().props, $e = () => U?.().open;
                              var fe = b(), oe = a(fe);
                              {
                                var me = (I) => {
                                  var H = yr();
                                  let T;
                                  Ue(H, 21, () => t(C).channels, Le, (F, z) => {
                                    var L = b();
                                    const ge = g(() => d().view.channels[t(z)]);
                                    var _e = a(L);
                                    x(_e, () => lt, (Ce, je) => {
                                      je(Ce, {
                                        onclick: () => nt(`/space/${ne.params.space}/${t(z)}`),
                                        get value() {
                                          return t(z);
                                        },
                                        class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
                                        children: (Je, We) => {
                                          var tt = br(), mt = $(tt);
                                          be(mt, {
                                            icon: "basil:comment-solid"
                                          });
                                          var It = y(mt);
                                          _(tt), de(() => ke(It, ` ${t(ge).name ?? ""}`)), r(Je, tt);
                                        },
                                        $$slots: {
                                          default: true
                                        }
                                      });
                                    }), r(F, L);
                                  }), _(H), de(() => T = Ve(H, T, {
                                    ...pe(),
                                    class: "flex flex-col gap-4 py-2"
                                  })), st(3, H, () => ht), r(I, H);
                                };
                                Y(oe, (I) => {
                                  $e() && I(me);
                                });
                              }
                              r(we, fe);
                            },
                            $$slots: {
                              child: true
                            }
                          });
                        }), r(ee, W);
                      },
                      $$slots: {
                        default: true
                      }
                    });
                  }), r(X, J);
                },
                $$slots: {
                  default: true
                }
              });
            }), r(ye, Ae);
          }, Oe = (ye) => {
            var Ae = b();
            const C = g(() => d().view.channels[t(he).id]);
            var q = a(Ae);
            x(q, () => lt, (Q, Z) => {
              Z(Q, {
                onclick: () => nt(`/space/${ne.params.space}/${t(he).id}`),
                get value() {
                  return t(he).id;
                },
                class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
                children: (X, k) => {
                  var J = wr(), S = $(J);
                  be(S, {
                    icon: "basil:comment-solid"
                  });
                  var R = y(S);
                  _(J), de(() => ke(R, ` ${t(C).name ?? ""}`)), r(X, J);
                },
                $$slots: {
                  default: true
                }
              });
            }), r(ye, Ae);
          };
          Y(Se, (ye) => {
            t(he).type == "category" ? ye(Ie) : ye(Oe, false);
          });
        }
        r(ae, Pe);
      }), _(N), st(3, N, () => ht), r(u, N);
    }, w = (u) => {
      var d = Ar();
      Ue(d, 21, () => Object.entries(t(G)), Le, (N, ae, he, Pe) => {
        let Se = () => t(ae)[0], Ie = () => t(ae)[1];
        var Oe = b(), ye = a(Oe);
        x(ye, () => lt, (Ae, C) => {
          C(Ae, {
            onclick: () => nt(`/space/${ne.params.space}/thread/${Se()}`),
            get value() {
              return Se();
            },
            class: "w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary",
            children: (q, Q) => {
              var Z = Cr(), X = $(Z);
              be(X, {
                icon: "material-symbols:thread-unread-rounded"
              });
              var k = y(X);
              _(Z), de(() => ke(k, ` ${Ie().title ?? ""}`)), r(q, Z);
            },
            $$slots: {
              default: true
            }
          });
        }), r(N, Oe);
      }), _(d), st(3, d, () => ht), r(u, d);
    };
    let p = g(() => (Mt.current || 0) < 640), f = le(ce([
      "channels",
      "threads"
    ])), s = g(() => _t.spaces[ne.params.space]), A = () => {
      if (!t(s)) return [];
      const u = /* @__PURE__ */ new Set();
      for (const N of Object.values(t(s).view.messages)) Kt(N) || u.add(N.author);
      return u.values().toArray().map((N) => {
        const ae = Rt(N);
        return {
          value: N,
          label: ae.handle,
          category: "user"
        };
      });
    }, G = g(() => t(s) ? Object.fromEntries(Object.entries(t(s).view.threads).filter(([u, d]) => !d.softDeleted)) : {}), P = g(() => {
      if (!t(s)) return [];
      const u = [];
      for (const d of Object.values(t(s).view.threads)) d.softDeleted || u.push({
        value: JSON.stringify({
          ulid: Qe,
          space: ne.params.space,
          type: "thread"
        }),
        label: d.title,
        category: "thread"
      });
      return u.push(...Object.values(t(s).view.channels).map((d) => ({
        value: JSON.stringify({
          ulid: Qe,
          space: ne.params.space,
          type: "channel"
        }),
        label: d.name,
        category: "channel"
      }))), u;
    }), D = g(() => t(s) && bt.agent && t(s).view.admins.includes(bt.agent.assertDid));
    Ke("isAdmin", {
      get value() {
        return t(D);
      }
    }), Ke("space", {
      get value() {
        return t(s);
      }
    }), Ke("users", {
      get value() {
        return A();
      }
    }), Ke("contextItems", {
      get value() {
        return t(P);
      }
    });
    let B = le(false), c = le("");
    function l() {
      t(s)?.change((u) => {
        const d = Qe();
        u.categories[d] = {
          channels: [],
          name: t(c)
        }, u.sidebarItems.push({
          type: "category",
          id: d
        });
      }), O(B, false);
    }
    let v = le("");
    jt(() => {
      ne.params.channel ? O(v, ce(ne.params.channel)) : O(v, ce(ne.params.thread));
    });
    let V = le(false), m = le(""), i = le(void 0);
    function ve() {
      const u = Qe();
      t(s)?.change((d) => {
        d.channels[u] = {
          name: t(m),
          threads: [],
          timeline: [],
          avatar: "",
          description: ""
        }, t(i) ? d.categories[t(i)].channels.push(u) : d.sidebarItems.push({
          type: "channel",
          id: u
        });
      }), O(i, void 0), O(m, ""), O(V, false);
    }
    function De() {
      t(s) || _t.catalog?.change((u) => {
        u.spaces.push({
          id: ne.params.space,
          knownMembers: []
        });
      });
    }
    let et = le(false), pt = le(""), ze = le("");
    function At() {
      t(s)?.change((u) => {
        u.categories[t(pt)].name = t(ze);
      }), O(et, false);
    }
    var ft = b(), Pt = a(ft);
    {
      var Dt = (u) => {
        var d = Br(), N = a(d), ae = $(N), he = $(ae, true);
        _(ae);
        var Pe = y(ae, 4);
        {
          var Se = (C) => {
            var q = Nr(), Q = $(q);
            ot(Q, {
              title: "Create Channel",
              get isDialogOpen() {
                return t(V);
              },
              set isDialogOpen(k) {
                O(V, ce(k));
              },
              dialogTrigger: (k) => {
                var J = b(), S = a(J);
                x(S, () => Te, (R, se) => {
                  se(R, {
                    title: "Create Channel",
                    class: "btn w-full justify-start join-item text-base-content",
                    children: (ee, te) => {
                      var W = Pr(), ie = a(W);
                      be(ie, {
                        icon: "basil:comment-plus-solid",
                        class: "size-6"
                      }), Ne(), r(ee, W);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), r(k, J);
              },
              children: (k, J) => {
                var S = Ir(), R = $(S), se = y($(R), 2);
                rt(se), _(R);
                var ee = y(R, 2), te = y($(ee), 2), W = $(te);
                W.value = (W.__value = void 0) == null ? "" : void 0;
                var ie = y(W);
                Ue(ie, 17, () => Object.keys(t(s).view.categories), Le, (M, K) => {
                  var re = Dr();
                  const we = g(() => t(s).view.categories[t(K)]);
                  var U = {}, pe = $(re, true);
                  _(re), de(() => {
                    U !== (U = t(K)) && (re.value = (re.__value = t(K)) == null ? "" : t(K)), ke(pe, t(we).name);
                  }), r(M, re);
                }), _(te), _(ee);
                var xe = y(ee, 2);
                x(xe, () => Te, (M, K) => {
                  K(M, {
                    class: "btn btn-primary",
                    children: (re, we) => {
                      var U = Sr(), pe = a(U);
                      be(pe, {
                        icon: "basil:add-outline",
                        "font-size": "1.8em"
                      }), Ne(), r(re, U);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), _(S), at("submit", S, ve), it(se, () => t(m), (M) => O(m, M)), Wt(te, () => t(i), (M) => O(i, M)), r(k, S);
              },
              $$slots: {
                dialogTrigger: true,
                default: true
              }
            });
            var Z = y(Q, 2);
            ot(Z, {
              title: "Create Category",
              get isDialogOpen() {
                return t(B);
              },
              set isDialogOpen(k) {
                O(B, ce(k));
              },
              dialogTrigger: (k) => {
                var J = b(), S = a(J);
                x(S, () => Te, (R, se) => {
                  se(R, {
                    class: "btn w-full justify-start join-item text-base-content",
                    title: "Create Category",
                    children: (ee, te) => {
                      var W = Tr(), ie = a(W);
                      be(ie, {
                        icon: "basil:folder-plus-solid",
                        class: "size-6"
                      }), Ne(), r(ee, W);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), r(k, J);
              },
              children: (k, J) => {
                var S = jr(), R = $(S), se = y($(R), 2);
                rt(se), _(R);
                var ee = y(R, 2);
                x(ee, () => Te, (te, W) => {
                  W(te, {
                    class: "btn btn-primary",
                    children: (ie, xe) => {
                      var M = Or(), K = a(M);
                      be(K, {
                        icon: "basil:add-outline",
                        "font-size": "1.8em"
                      }), Ne(), r(ie, M);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), _(S), at("submit", S, l), it(se, () => t(c), (te) => O(c, te)), r(k, S);
              },
              $$slots: {
                dialogTrigger: true,
                default: true
              }
            }), _(q), r(C, q);
          };
          Y(Pe, (C) => {
            t(D) && C(Se);
          });
        }
        var Ie = y(Pe, 2);
        x(Ie, () => Ut, (C, q) => {
          q(C, {
            type: "single",
            get value() {
              return t(v);
            },
            set value(Q) {
              O(v, ce(Q));
            },
            children: (Q, Z) => {
              var X = b(), k = a(X);
              x(k, () => yt, (J, S) => {
                S(J, {
                  type: "multiple",
                  class: "flex flex-col gap-4",
                  get value() {
                    return t(f);
                  },
                  set value(R) {
                    O(f, ce(R));
                  },
                  children: (R, se) => {
                    var ee = Vr(), te = a(ee);
                    x(te, () => ct, (xe, M) => {
                      M(xe, {
                        value: "channels",
                        children: (K, re) => {
                          var we = Rr(), U = a(we);
                          x(U, () => dt, ($e, fe) => {
                            fe($e, {
                              children: (oe, me) => {
                                var I = b(), H = a(I);
                                x(H, () => ut, (T, F) => {
                                  F(T, {
                                    class: "cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content",
                                    children: (z, L) => {
                                      var ge = kr(), _e = y(a(ge), 2);
                                      const Ce = g(() => `size-4 transition-transform duration-150 ${t(f).includes("channels") && "rotate-180"}`);
                                      be(_e, {
                                        icon: "basil:caret-up-solid",
                                        get class() {
                                          return t(Ce);
                                        }
                                      }), r(z, ge);
                                    },
                                    $$slots: {
                                      default: true
                                    }
                                  });
                                }), r(oe, I);
                              },
                              $$slots: {
                                default: true
                              }
                            });
                          });
                          var pe = y(U, 2);
                          x(pe, () => vt, ($e, fe) => {
                            fe($e, {
                              forceMount: true,
                              child: (me, I) => {
                                let H = () => I?.().open;
                                var T = b(), F = a(T);
                                {
                                  var z = (L) => {
                                    h(L, () => t(s));
                                  };
                                  Y(F, (L) => {
                                    H() && L(z);
                                  });
                                }
                                r(me, T);
                              },
                              $$slots: {
                                child: true
                              }
                            });
                          }), r(K, we);
                        },
                        $$slots: {
                          default: true
                        }
                      });
                    });
                    var W = y(te, 2);
                    {
                      var ie = (xe) => {
                        var M = Er(), K = y(a(M), 2);
                        x(K, () => ct, (re, we) => {
                          we(re, {
                            value: "threads",
                            children: (U, pe) => {
                              var $e = Fr(), fe = a($e);
                              x(fe, () => dt, (me, I) => {
                                I(me, {
                                  children: (H, T) => {
                                    var F = b(), z = a(F);
                                    x(z, () => ut, (L, ge) => {
                                      ge(L, {
                                        class: "cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content",
                                        children: (_e, Ce) => {
                                          var je = Mr(), Je = y(a(je), 2);
                                          const We = g(() => `size-4 transition-transform duration-150 ${t(f).includes("threads") && "rotate-180"}`);
                                          be(Je, {
                                            icon: "basil:caret-up-solid",
                                            get class() {
                                              return t(We);
                                            }
                                          }), r(_e, je);
                                        },
                                        $$slots: {
                                          default: true
                                        }
                                      });
                                    }), r(H, F);
                                  },
                                  $$slots: {
                                    default: true
                                  }
                                });
                              });
                              var oe = y(fe, 2);
                              x(oe, () => vt, (me, I) => {
                                I(me, {
                                  child: (T, F) => {
                                    let z = () => F?.().open;
                                    var L = b(), ge = a(L);
                                    {
                                      var _e = (Ce) => {
                                        w(Ce);
                                      };
                                      Y(ge, (Ce) => {
                                        z() && Ce(_e);
                                      });
                                    }
                                    r(T, L);
                                  },
                                  $$slots: {
                                    child: true
                                  }
                                });
                              }), r(U, $e);
                            },
                            $$slots: {
                              default: true
                            }
                          });
                        }), r(xe, M);
                      };
                      Y(W, (xe) => {
                        Object.keys(t(G)).length > 0 && xe(ie);
                      });
                    }
                    r(R, ee);
                  },
                  $$slots: {
                    default: true
                  }
                });
              }), r(Q, X);
            },
            $$slots: {
              default: true
            }
          });
        }), _(N);
        var Oe = y(N, 2);
        {
          var ye = (C) => {
            var q = zr(), Q = $(q);
            ue(Q, () => e.children), _(q), r(C, q);
          }, Ae = (C, q) => {
            {
              var Q = (Z) => {
                var X = Gr(), k = $(X);
                ue(k, () => e.children), _(X), r(Z, X);
              };
              Y(C, (Z) => {
                (ne.params.channel || ne.params.thread) && Z(Q);
              }, q);
            }
          };
          Y(Oe, (C) => {
            t(p) ? C(Ae, false) : C(ye);
          });
        }
        de(() => {
          Nt(N, 1, kt([
            !t(p) && "max-w-[16rem] border-r-2 border-base-200",
            "px-4 py-5 flex flex-col gap-4 w-full"
          ])), ke(he, t(s).view.name);
        }), r(u, d);
      }, St = (u) => {
        var d = qr(), N = $(d);
        x(N, () => Te, (ae, he) => {
          he(ae, {
            onclick: De,
            class: "px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer",
            children: (Pe, Se) => {
              Ne();
              var Ie = gt("Join Space");
              r(Pe, Ie);
            },
            $$slots: {
              default: true
            }
          });
        }), _(d), r(u, d);
      };
      Y(Pt, (u) => {
        t(s) ? u(Dt) : u(St, false);
      });
    }
    r(n, ft), Fe();
  };
});
export {
  __tla,
  ha as component
};
