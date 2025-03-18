import "./NZTpNUN0.js";
import { e as f, g as s, d as T, b as A, p as J, f as p, a as L, c as j, m as Q, r as q, t as G, A as mt, s as U, n as pt } from "./BMAj9zKA.js";
import { s as gt } from "./DzGbYseb.js";
import { i as H } from "./BA1UOs1h.js";
import { c as w, a, t as E, e as vt } from "./pDBoOQRd.js";
import { s as D } from "./k4NpJaFV.js";
import { c as B } from "./BUHZJKy3.js";
import { p as l, r as Y, s as st } from "./D_-9kNr4.js";
import { I as wt } from "./7tHZr1X2.js";
import { b as Z } from "./DjDC-EQm.js";
import { C as Dt, a as $, S as bt, E as yt, s as xt, q as St, i as tt, j as v, m as O, v as Pt, n as lt, F as kt, x as It, D as Ct, T as Nt, y as _t, P as Ot, __tla as __tla_0 } from "./BOaKtN8S.js";
import { p as M } from "./Baj-A2iI.js";
let we;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  function Et(r) {
    return {
      content: `data-${r}-content`,
      trigger: `data-${r}-trigger`,
      overlay: `data-${r}-overlay`,
      title: `data-${r}-title`,
      description: `data-${r}-description`,
      close: `data-${r}-close`,
      cancel: `data-${r}-cancel`,
      action: `data-${r}-action`
    };
  }
  class Ft {
    opts;
    #t = T(null);
    get triggerNode() {
      return s(this.#t);
    }
    set triggerNode(t) {
      A(this.#t, M(t));
    }
    #e = T(null);
    get titleNode() {
      return s(this.#e);
    }
    set titleNode(t) {
      A(this.#e, M(t));
    }
    #r = T(null);
    get contentNode() {
      return s(this.#r);
    }
    set contentNode(t) {
      A(this.#r, M(t));
    }
    #o = T(null);
    get descriptionNode() {
      return s(this.#o);
    }
    set descriptionNode(t) {
      A(this.#o, M(t));
    }
    #s = T(void 0);
    get contentId() {
      return s(this.#s);
    }
    set contentId(t) {
      A(this.#s, M(t));
    }
    #n = T(void 0);
    get titleId() {
      return s(this.#n);
    }
    set titleId(t) {
      A(this.#n, M(t));
    }
    #i = T(void 0);
    get triggerId() {
      return s(this.#i);
    }
    set triggerId(t) {
      A(this.#i, M(t));
    }
    #a = T(void 0);
    get descriptionId() {
      return s(this.#a);
    }
    set descriptionId(t) {
      A(this.#a, M(t));
    }
    #l = T(null);
    get cancelNode() {
      return s(this.#l);
    }
    set cancelNode(t) {
      A(this.#l, M(t));
    }
    #d = f(() => Et(this.opts.variant.current));
    get attrs() {
      return s(this.#d);
    }
    constructor(t) {
      this.opts = t, this.handleOpen = this.handleOpen.bind(this), this.handleClose = this.handleClose.bind(this);
    }
    handleOpen() {
      this.opts.open.current || (this.opts.open.current = true);
    }
    handleClose() {
      this.opts.open.current && (this.opts.open.current = false);
    }
    #c = f(() => ({
      "data-state": St(this.opts.open.current)
    }));
    get sharedProps() {
      return s(this.#c);
    }
  }
  class Rt {
    opts;
    root;
    constructor(t, i) {
      this.opts = t, this.root = i, $({
        ...t,
        onRefChange: (n) => {
          this.root.triggerNode = n, this.root.triggerId = n?.id;
        }
      }), this.onclick = this.onclick.bind(this), this.onkeydown = this.onkeydown.bind(this);
    }
    onclick(t) {
      this.opts.disabled.current || t.button > 0 || this.root.handleOpen();
    }
    onkeydown(t) {
      this.opts.disabled.current || (t.key === bt || t.key === yt) && (t.preventDefault(), this.root.handleOpen());
    }
    #t = f(() => ({
      id: this.opts.id.current,
      "aria-haspopup": "dialog",
      "aria-expanded": xt(this.root.opts.open.current),
      "aria-controls": this.root.contentId,
      [this.root.attrs.trigger]: "",
      onkeydown: this.onkeydown,
      onclick: this.onclick,
      disabled: this.opts.disabled.current ? true : void 0,
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#t);
    }
  }
  class Tt {
    opts;
    root;
    #t = f(() => this.root.attrs[this.opts.variant.current]);
    constructor(t, i) {
      this.opts = t, this.root = i, this.onclick = this.onclick.bind(this), this.onkeydown = this.onkeydown.bind(this), $({
        ...t,
        deps: () => this.root.opts.open.current
      });
    }
    onclick(t) {
      this.opts.disabled.current || t.button > 0 || this.root.handleClose();
    }
    onkeydown(t) {
      this.opts.disabled.current || (t.key === bt || t.key === yt) && (t.preventDefault(), this.root.handleClose());
    }
    #e = f(() => ({
      id: this.opts.id.current,
      [s(this.#t)]: "",
      onclick: this.onclick,
      onkeydown: this.onkeydown,
      disabled: this.opts.disabled.current ? true : void 0,
      tabindex: 0,
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#e);
    }
  }
  class At {
    opts;
    root;
    constructor(t, i) {
      this.opts = t, this.root = i, $({
        ...t,
        onRefChange: (n) => {
          this.root.titleNode = n, this.root.titleId = n?.id;
        },
        deps: () => this.root.opts.open.current
      });
    }
    #t = f(() => ({
      id: this.opts.id.current,
      role: "heading",
      "aria-level": this.opts.level.current,
      [this.root.attrs.title]: "",
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#t);
    }
  }
  class Mt {
    opts;
    root;
    constructor(t, i) {
      this.opts = t, this.root = i, $({
        ...t,
        deps: () => this.root.opts.open.current,
        onRefChange: (n) => {
          this.root.descriptionNode = n, this.root.descriptionId = n?.id;
        }
      });
    }
    #t = f(() => ({
      id: this.opts.id.current,
      [this.root.attrs.description]: "",
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#t);
    }
  }
  class Kt {
    opts;
    root;
    constructor(t, i) {
      this.opts = t, this.root = i, $({
        ...t,
        deps: () => this.root.opts.open.current,
        onRefChange: (n) => {
          this.root.contentNode = n, this.root.contentId = n?.id;
        }
      });
    }
    #t = f(() => ({
      open: this.root.opts.open.current
    }));
    get snippetProps() {
      return s(this.#t);
    }
    #e = f(() => ({
      id: this.opts.id.current,
      role: this.root.opts.variant.current === "alert-dialog" ? "alertdialog" : "dialog",
      "aria-modal": "true",
      "aria-describedby": this.root.descriptionId,
      "aria-labelledby": this.root.titleId,
      [this.root.attrs.content]: "",
      style: {
        pointerEvents: "auto",
        outline: this.root.opts.variant.current === "alert-dialog" ? "none" : void 0
      },
      tabindex: this.root.opts.variant.current === "alert-dialog" ? -1 : void 0,
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#e);
    }
  }
  class zt {
    opts;
    root;
    constructor(t, i) {
      this.opts = t, this.root = i, $({
        ...t,
        deps: () => this.root.opts.open.current
      });
    }
    #t = f(() => ({
      open: this.root.opts.open.current
    }));
    get snippetProps() {
      return s(this.#t);
    }
    #e = f(() => ({
      id: this.opts.id.current,
      [this.root.attrs.overlay]: "",
      style: {
        pointerEvents: "auto"
      },
      ...this.root.sharedProps
    }));
    get props() {
      return s(this.#e);
    }
  }
  const V = new Dt("Dialog.Root");
  function Bt(r) {
    return V.set(new Ft(r));
  }
  function jt(r) {
    return new Rt(r, V.get());
  }
  function qt(r) {
    return new At(r, V.get());
  }
  function Gt(r) {
    return new Kt(r, V.get());
  }
  function Ht(r) {
    return new zt(r, V.get());
  }
  function Jt(r) {
    return new Mt(r, V.get());
  }
  function Lt(r) {
    return new Tt(r, V.get());
  }
  var Qt = E("<div><!></div>");
  function Ut(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "ref", 15, null), g = l(t, "level", 3, 2), b = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "child",
      "children",
      "level"
    ]);
    const u = qt({
      id: v.with(() => i()),
      level: v.with(() => g()),
      ref: v.with(() => n(), (e) => n(e))
    }), h = f(() => O(b, u.props));
    var y = w(), m = p(y);
    {
      var x = (e) => {
        var o = w(), d = p(o);
        D(d, () => t.child, () => ({
          props: s(h)
        })), a(e, o);
      }, c = (e) => {
        var o = Qt();
        let d;
        var _ = j(o);
        D(_, () => t.children ?? Q), q(o), G(() => d = Z(o, d, {
          ...s(h)
        })), a(e, o);
      };
      H(m, (e) => {
        t.child ? e(x) : e(c, false);
      });
    }
    a(r, y), L();
  }
  function Vt({ forceMount: r, present: t, trapFocus: i, open: n }) {
    return r ? n && i : t && i && n;
  }
  var Wt = E("<div><!></div>");
  function Xt(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "forceMount", 3, false), g = l(t, "ref", 15, null), b = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "forceMount",
      "child",
      "children",
      "ref"
    ]);
    const u = Ht({
      id: v.with(() => i()),
      ref: v.with(() => g(), (m) => g(m))
    }), h = f(() => O(b, u.props)), y = f(() => u.root.opts.open.current || n());
    Pt(r, {
      get id() {
        return i();
      },
      get present() {
        return s(y);
      },
      presence: (x) => {
        var c = w(), e = p(c);
        {
          var o = (_) => {
            var P = w(), k = p(P), W = mt(() => ({
              props: O(s(h)),
              ...u.snippetProps
            }));
            D(k, () => t.child, () => s(W)), a(_, P);
          }, d = (_) => {
            var P = Wt();
            let k;
            var W = j(P);
            D(W, () => t.children ?? Q, () => u.snippetProps), q(P), G((C) => k = Z(P, k, {
              ...C
            }), [
              () => O(s(h))
            ]), a(_, P);
          };
          H(e, (_) => {
            t.child ? _(o) : _(d, false);
          });
        }
        a(x, c);
      },
      $$slots: {
        presence: true
      }
    }), L();
  }
  var Yt = E("<button><!></button>");
  function Zt(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "ref", 15, null), g = l(t, "disabled", 3, false), b = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "children",
      "child",
      "disabled"
    ]);
    const u = jt({
      id: v.with(() => i()),
      ref: v.with(() => n(), (e) => n(e)),
      disabled: v.with(() => !!g())
    }), h = f(() => O(b, u.props));
    var y = w(), m = p(y);
    {
      var x = (e) => {
        var o = w(), d = p(o);
        D(d, () => t.child, () => ({
          props: s(h)
        })), a(e, o);
      }, c = (e) => {
        var o = Yt();
        let d;
        var _ = j(o);
        D(_, () => t.children ?? Q), q(o), G(() => d = Z(o, d, {
          ...s(h)
        })), a(e, o);
      };
      H(m, (e) => {
        t.child ? e(x) : e(c, false);
      });
    }
    a(r, y), L();
  }
  var $t = E("<div><!></div>");
  function te(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "ref", 15, null), g = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "children",
      "child",
      "ref"
    ]);
    const b = Jt({
      id: v.with(() => i()),
      ref: v.with(() => n(), (c) => n(c))
    }), u = f(() => O(g, b.props));
    var h = w(), y = p(h);
    {
      var m = (c) => {
        var e = w(), o = p(e);
        D(o, () => t.child, () => ({
          props: s(u)
        })), a(c, e);
      }, x = (c) => {
        var e = $t();
        let o;
        var d = j(e);
        D(d, () => t.children ?? Q), q(e), G(() => o = Z(e, o, {
          ...s(u)
        })), a(c, e);
      };
      H(y, (c) => {
        t.child ? c(m) : c(x, false);
      });
    }
    a(r, h), L();
  }
  function ee(r, t) {
    J(t, true);
    let i = l(t, "open", 15, false), n = l(t, "onOpenChange", 3, lt);
    Bt({
      variant: v.with(() => "dialog"),
      open: v.with(() => i(), (u) => {
        i(u), n()(u);
      })
    });
    var g = w(), b = p(g);
    D(b, () => t.children ?? Q), a(r, g), L();
  }
  var re = E("<button><!></button>");
  function oe(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "ref", 15, null), g = l(t, "disabled", 3, false), b = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "children",
      "child",
      "id",
      "ref",
      "disabled"
    ]);
    const u = Lt({
      variant: v.with(() => "close"),
      id: v.with(() => i()),
      ref: v.with(() => n(), (e) => n(e)),
      disabled: v.with(() => !!g())
    }), h = f(() => O(b, u.props));
    var y = w(), m = p(y);
    {
      var x = (e) => {
        var o = w(), d = p(o);
        D(d, () => t.child, () => ({
          props: s(h)
        })), a(e, o);
      }, c = (e) => {
        var o = re();
        let d;
        var _ = j(o);
        D(_, () => t.children ?? Q), q(o), G(() => d = Z(o, d, {
          ...s(h)
        })), a(e, o);
      };
      H(m, (e) => {
        t.child ? e(x) : e(c, false);
      });
    }
    a(r, y), L();
  }
  var se = E("<!> <!>", 1), ne = E("<!> <div><!></div>", 1);
  function ie(r, t) {
    J(t, true);
    let i = l(t, "id", 19, tt), n = l(t, "ref", 15, null), g = l(t, "forceMount", 3, false), b = l(t, "onCloseAutoFocus", 3, lt), u = l(t, "onEscapeKeydown", 3, lt), h = l(t, "onInteractOutside", 3, lt), y = l(t, "trapFocus", 3, true), m = l(t, "preventScroll", 3, true), x = l(t, "restoreScrollDelay", 3, null), c = Y(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "children",
      "child",
      "ref",
      "forceMount",
      "onCloseAutoFocus",
      "onEscapeKeydown",
      "onInteractOutside",
      "trapFocus",
      "preventScroll",
      "restoreScrollDelay"
    ]);
    const e = Gt({
      id: v.with(() => i()),
      ref: v.with(() => n(), (_) => n(_))
    }), o = f(() => O(c, e.props)), d = f(() => e.root.opts.open.current || g());
    Pt(r, st(() => s(o), {
      get forceMount() {
        return g();
      },
      get present() {
        return s(d);
      },
      presence: (P) => {
        const k = f(() => Vt({
          forceMount: g(),
          present: e.root.opts.open.current,
          trapFocus: y(),
          open: e.root.opts.open.current
        }));
        kt(P, st({
          loop: true,
          get trapFocus() {
            return s(k);
          }
        }, () => s(o), {
          onCloseAutoFocus: (C) => {
            b()(C), !C.defaultPrevented && e.root.triggerNode?.focus();
          },
          focusScope: (C, et) => {
            let nt = () => et?.().props;
            It(C, st(() => s(o), {
              get enabled() {
                return e.root.opts.open.current;
              },
              onEscapeKeydown: (rt) => {
                u()(rt), !rt.defaultPrevented && e.root.handleClose();
              },
              children: (rt, dt) => {
                Ct(rt, st(() => s(o), {
                  get enabled() {
                    return e.root.opts.open.current;
                  },
                  onInteractOutside: (K) => {
                    h()(K), !K.defaultPrevented && e.root.handleClose();
                  },
                  children: (K, ct) => {
                    Nt(K, st(() => s(o), {
                      get enabled() {
                        return e.root.opts.open.current;
                      },
                      children: (it, ft) => {
                        var ot = w(), ut = p(ot);
                        {
                          var ht = (S) => {
                            var I = se(), R = p(I);
                            {
                              var N = (z) => {
                                _t(z, {
                                  get preventScroll() {
                                    return m();
                                  },
                                  get restoreScrollDelay() {
                                    return x();
                                  }
                                });
                              };
                              H(R, (z) => {
                                e.root.opts.open.current && z(N);
                              });
                            }
                            var X = U(R, 2), at = mt(() => ({
                              props: O(s(o), nt()),
                              ...e.snippetProps
                            }));
                            D(X, () => t.child, () => s(at)), a(S, I);
                          }, F = (S) => {
                            var I = ne(), R = p(I);
                            _t(R, {
                              get preventScroll() {
                                return m();
                              }
                            });
                            var N = U(R, 2);
                            let X;
                            var at = j(N);
                            D(at, () => t.children ?? Q), q(N), G((z) => X = Z(N, X, {
                              ...z
                            }), [
                              () => O(s(o), nt())
                            ]), a(S, I);
                          };
                          H(ut, (S) => {
                            t.child ? S(ht) : S(F, false);
                          });
                        }
                        a(it, ot);
                      },
                      $$slots: {
                        default: true
                      }
                    }));
                  },
                  $$slots: {
                    default: true
                  }
                }));
              },
              $$slots: {
                default: true
              }
            }));
          },
          $$slots: {
            focusScope: true
          }
        }));
      },
      $$slots: {
        presence: true
      }
    })), L();
  }
  var ae = E('<div class="flex flex-col gap-3"><header class="flex justify-between items-center"><!> <!></header> <div class="divider my-0"></div></div> <!> <!>', 1), le = E("<!> <!>", 1), de = E("<!> <!>", 1);
  we = function(r, t) {
    J(t, true);
    let i = l(t, "isDialogOpen", 15, false);
    var n = w(), g = p(n);
    B(g, () => ee, (b, u) => {
      u(b, {
        get open() {
          return i();
        },
        set open(h) {
          i(h);
        },
        children: (h, y) => {
          var m = de(), x = p(m);
          B(x, () => Zt, (e, o) => {
            o(e, {
              children: (d, _) => {
                var P = w(), k = p(P);
                D(k, () => t.dialogTrigger), a(d, P);
              },
              $$slots: {
                default: true
              }
            });
          });
          var c = U(x, 2);
          B(c, () => Ot, (e, o) => {
            o(e, {
              children: (d, _) => {
                var P = le(), k = p(P);
                B(k, () => Xt, (C, et) => {
                  et(C, {
                    class: "fixed inset-0 z-50 bg-black/80"
                  });
                });
                var W = U(k, 2);
                B(W, () => ie, (C, et) => {
                  et(C, {
                    class: "fixed p-5 flex flex-col bg-base-200 rounded-box gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] ",
                    children: (nt, rt) => {
                      var dt = ae(), K = p(dt), ct = j(K), it = j(ct);
                      B(it, () => Ut, (F, S) => {
                        S(F, {
                          class: "text-xl font-bold",
                          children: (I, R) => {
                            pt();
                            var N = vt();
                            G(() => gt(N, t.title)), a(I, N);
                          },
                          $$slots: {
                            default: true
                          }
                        });
                      });
                      var ft = U(it, 2);
                      B(ft, () => oe, (F, S) => {
                        S(F, {
                          class: "btn btn-circle",
                          children: (I, R) => {
                            wt(I, {
                              icon: "zondicons:close-solid"
                            });
                          },
                          $$slots: {
                            default: true
                          }
                        });
                      }), q(ct), pt(2), q(K);
                      var ot = U(K, 2);
                      {
                        var ut = (F) => {
                          var S = w(), I = p(S);
                          B(I, () => te, (R, N) => {
                            N(R, {
                              class: "text-sm",
                              children: (X, at) => {
                                pt();
                                var z = vt();
                                G(() => gt(z, t.description)), a(X, z);
                              },
                              $$slots: {
                                default: true
                              }
                            });
                          }), a(F, S);
                        };
                        H(ot, (F) => {
                          t.description && F(ut);
                        });
                      }
                      var ht = U(ot, 2);
                      D(ht, () => t.children ?? Q), a(nt, dt);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), a(d, P);
              },
              $$slots: {
                default: true
              }
            });
          }), a(h, m);
        },
        $$slots: {
          default: true
        }
      });
    }), a(r, n), L();
  };
});
export {
  we as D,
  __tla
};
