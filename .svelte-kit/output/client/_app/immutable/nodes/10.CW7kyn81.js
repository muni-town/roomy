import "../chunks/NZTpNUN0.js";
import { e as h, g as e, d as Y, u as Se, b, p as be, f as D, a as xe, c, m as Te, r as l, t as ie, i as me, j as ve, s as v, n as Ge } from "../chunks/BMAj9zKA.js";
import { s as ge } from "../chunks/DzGbYseb.js";
import { i as U } from "../chunks/BA1UOs1h.js";
import { e as Ve, i as Le } from "../chunks/BuDgEN05.js";
import { I as le, h as gt } from "../chunks/7tHZr1X2.js";
import { c as Z, a as n, t as f, e as mt } from "../chunks/pDBoOQRd.js";
import { c as q } from "../chunks/BUHZJKy3.js";
import { b as $e, a as _t, r as Ue, s as bt } from "../chunks/DjDC-EQm.js";
import { e as ze } from "../chunks/BSdt-dIf.js";
import { C as xt, a as Oe, e as Xe, f as De, k as Tt, w as yt, S as wt, E as It, d as Pt, l as Ct, o as He, h as kt, i as Ae, n as St, j as Q, m as Re, B as pe, P as $t, b as Je, u as _e, p as Ot, __tla as __tla_0 } from "../chunks/BOaKtN8S.js";
import { b as Dt } from "../chunks/B9N9amIG.js";
import { p as L } from "../chunks/Baj-A2iI.js";
import { __tla as __tla_1 } from "../chunks/BUkYaDtB.js";
import { p as y } from "../chunks/_G7J8Uer.js";
import { g as Ke } from "../chunks/BNjT_JuR.js";
import { A as We, t as At, __tla as __tla_2 } from "../chunks/DfzdJtdG.js";
import { u as ke } from "../chunks/D7Oepc1u.js";
import { P as Rt, a as jt, b as Mt, f as qe, i as Et, C as Bt, c as Nt, g as Ft, __tla as __tla_3 } from "../chunks/qqh-ZKrk.js";
import { o as Gt, __tla as __tla_4 } from "../chunks/C8D1QxlH.js";
import { D as Vt, __tla as __tla_5 } from "../chunks/CmGwp3aM.js";
import { s as he } from "../chunks/k4NpJaFV.js";
import { p as z, r as je } from "../chunks/D_-9kNr4.js";
let Ja;
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
  const Lt = "data-tabs-root", Ut = "data-tabs-list", Ye = "data-tabs-trigger";
  class zt {
    opts;
    rovingFocusGroup;
    #t = Y(L([]));
    get triggerIds() {
      return e(this.#t);
    }
    set triggerIds(t) {
      b(this.#t, L(t));
    }
    valueToTriggerId = new He();
    valueToContentId = new He();
    constructor(t) {
      this.opts = t, Oe(t), this.rovingFocusGroup = kt({
        candidateAttr: Ye,
        rootNodeId: this.opts.id,
        loop: this.opts.loop,
        orientation: this.opts.orientation
      });
    }
    registerTrigger(t, p) {
      return this.triggerIds.push(t), this.valueToTriggerId.set(p, t), () => {
        this.triggerIds = this.triggerIds.filter((C) => C !== t), this.valueToTriggerId.delete(p);
      };
    }
    registerContent(t, p) {
      return this.valueToContentId.set(p, t), () => {
        this.valueToContentId.delete(p);
      };
    }
    setValue(t) {
      this.opts.value.current = t;
    }
    #e = h(() => ({
      id: this.opts.id.current,
      "data-orientation": De(this.opts.orientation.current),
      [Lt]: ""
    }));
    get props() {
      return e(this.#e);
    }
  }
  class Ht {
    opts;
    root;
    #t = h(() => this.root.opts.disabled.current);
    constructor(t, p) {
      this.opts = t, this.root = p, Oe(t);
    }
    #e = h(() => ({
      id: this.opts.id.current,
      role: "tablist",
      "aria-orientation": Tt(this.root.opts.orientation.current),
      "data-orientation": De(this.root.opts.orientation.current),
      [Ut]: "",
      "data-disabled": Xe(e(this.#t))
    }));
    get props() {
      return e(this.#e);
    }
  }
  class Jt {
    opts;
    root;
    #t = h(() => this.root.opts.value.current === this.opts.value.current);
    #e = h(() => this.opts.disabled.current || this.root.opts.disabled.current);
    #a = Y(0);
    #r = h(() => this.root.valueToContentId.get(this.opts.value.current));
    constructor(t, p) {
      this.opts = t, this.root = p, Oe(t), yt([
        () => this.opts.id.current,
        () => this.opts.value.current
      ], ([C, H]) => this.root.registerTrigger(C, H)), Se(() => {
        this.root.triggerIds.length, e(this.#t) || !this.root.opts.value.current ? b(this.#a, 0) : b(this.#a, -1);
      }), this.onfocus = this.onfocus.bind(this), this.onclick = this.onclick.bind(this), this.onkeydown = this.onkeydown.bind(this);
    }
    #s() {
      this.root.opts.value.current !== this.opts.value.current && this.root.setValue(this.opts.value.current);
    }
    onfocus(t) {
      this.root.opts.activationMode.current !== "automatic" || e(this.#e) || this.#s();
    }
    onclick(t) {
      e(this.#e) || this.#s();
    }
    onkeydown(t) {
      if (!e(this.#e)) {
        if (t.key === wt || t.key === It) {
          t.preventDefault(), this.#s();
          return;
        }
        this.root.rovingFocusGroup.handleKeydown(this.opts.ref.current, t);
      }
    }
    #n = h(() => ({
      id: this.opts.id.current,
      role: "tab",
      "data-state": Qt(e(this.#t)),
      "data-value": this.opts.value.current,
      "data-orientation": De(this.root.opts.orientation.current),
      "data-disabled": Xe(e(this.#e)),
      "aria-selected": Ct(e(this.#t)),
      "aria-controls": e(this.#r),
      [Ye]: "",
      disabled: Pt(e(this.#e)),
      tabindex: e(this.#a),
      onclick: this.onclick,
      onfocus: this.onfocus,
      onkeydown: this.onkeydown
    }));
    get props() {
      return e(this.#n);
    }
  }
  const Me = new xt("Tabs.Root");
  function Kt(_) {
    return Me.set(new zt(_));
  }
  function Wt(_) {
    return new Jt(_, Me.get());
  }
  function qt(_) {
    return new Ht(_, Me.get());
  }
  function Qt(_) {
    return _ ? "active" : "inactive";
  }
  var Xt = f("<div><!></div>");
  function Yt(_, t) {
    be(t, true);
    let p = z(t, "id", 19, Ae), C = z(t, "ref", 15, null), H = z(t, "value", 15, ""), k = z(t, "onValueChange", 3, St), ee = z(t, "orientation", 3, "horizontal"), o = z(t, "loop", 3, true), S = z(t, "activationMode", 3, "automatic"), se = z(t, "disabled", 3, false), oe = je(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "id",
      "ref",
      "value",
      "onValueChange",
      "orientation",
      "loop",
      "activationMode",
      "disabled",
      "children",
      "child"
    ]);
    const B = Kt({
      id: Q.with(() => p()),
      value: Q.with(() => H(), (x) => {
        H(x), k()(x);
      }),
      orientation: Q.with(() => ee()),
      loop: Q.with(() => o()),
      activationMode: Q.with(() => S()),
      disabled: Q.with(() => se()),
      ref: Q.with(() => C(), (x) => C(x))
    }), A = h(() => Re(oe, B.props));
    var g = Z(), J = D(g);
    {
      var K = (x) => {
        var w = Z(), ce = D(w);
        he(ce, () => t.child, () => ({
          props: e(A)
        })), n(x, w);
      }, re = (x) => {
        var w = Xt();
        let ce;
        var ye = c(w);
        he(ye, () => t.children ?? Te), l(w), ie(() => ce = $e(w, ce, {
          ...e(A)
        })), n(x, w);
      };
      U(J, (x) => {
        t.child ? x(K) : x(re, false);
      });
    }
    n(_, g), xe();
  }
  var Zt = f("<div><!></div>");
  function ea(_, t) {
    be(t, true);
    let p = z(t, "id", 19, Ae), C = z(t, "ref", 15, null), H = je(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "child",
      "children",
      "id",
      "ref"
    ]);
    const k = qt({
      id: Q.with(() => p()),
      ref: Q.with(() => C(), (B) => C(B))
    }), ee = h(() => Re(H, k.props));
    var o = Z(), S = D(o);
    {
      var se = (B) => {
        var A = Z(), g = D(A);
        he(g, () => t.child, () => ({
          props: e(ee)
        })), n(B, A);
      }, oe = (B) => {
        var A = Zt();
        let g;
        var J = c(A);
        he(J, () => t.children ?? Te), l(A), ie(() => g = $e(A, g, {
          ...e(ee)
        })), n(B, A);
      };
      U(S, (B) => {
        t.child ? B(se) : B(oe, false);
      });
    }
    n(_, o), xe();
  }
  var ta = f("<button><!></button>");
  function Qe(_, t) {
    be(t, true);
    let p = z(t, "disabled", 3, false), C = z(t, "id", 19, Ae), H = z(t, "type", 3, "button"), k = z(t, "ref", 15, null), ee = je(t, [
      "$$slots",
      "$$events",
      "$$legacy",
      "child",
      "children",
      "disabled",
      "id",
      "type",
      "value",
      "ref"
    ]);
    const o = Wt({
      id: Q.with(() => C()),
      disabled: Q.with(() => p() ?? false),
      value: Q.with(() => t.value),
      ref: Q.with(() => k(), (g) => k(g))
    }), S = h(() => Re(ee, o.props, {
      type: H()
    }));
    var se = Z(), oe = D(se);
    {
      var B = (g) => {
        var J = Z(), K = D(J);
        he(K, () => t.child, () => ({
          props: e(S)
        })), n(g, J);
      }, A = (g) => {
        var J = ta();
        let K;
        var re = c(J);
        he(re, () => t.children ?? Te), l(J), ie(() => K = $e(J, K, {
          ...e(S)
        })), n(g, J);
      };
      U(oe, (g) => {
        t.child ? g(B) : g(A, false);
      });
    }
    n(_, se), xe();
  }
  const aa = (_, t = Te) => {
    var p = na();
    const C = h(() => Ot(t())), H = h(() => Et(e(C)) ? "Today" : qe(e(C), "P"));
    var k = c(p);
    l(p), ie((ee) => ge(k, `${e(H) ?? ""}, ${ee ?? ""}`), [
      () => qe(e(C), "pp")
    ]), n(_, p);
  };
  var sa = f('<a><li class="list-row join-item flex items-center w-full bg-base-200"><h3 class="card-title text-xl font-medium text-primary"> </h3> <!></li></a>'), ra = f('<ul class="list w-full join join-vertical"></ul>'), na = f('<time class="text-xs"> </time>'), ia = f('<div class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"><div class="flex flex-col gap-1"><h5 class="flex gap-2 items-center">Replying to <!> <strong> </strong></h5> <p class="text-gray-300 text-ellipsis italic"><!></p></div> <!></div>'), oa = f('<section class="grow flex flex-col"><!> <div class="relative"><!></div></section>'), la = f('<!> <div class="flex items-center"><!> <!></div>', 1), ca = f('<form class="flex flex-col gap-4"><input type="text" class="input" placeholder="Thread Title"> <button type="submit" class="btn btn-primary">Create Thread</button></form>'), da = f("<!> <!>", 1), ua = f("<option> </option>"), va = f('<select class="select"><option>None</option><!></select>'), ha = f('<form class="flex flex-col gap-4 w-full"><label>Name <input placeholder="channel-name" class="input"></label> <!> <!></form>'), fa = f('<menu class="relative flex items-center gap-3 px-2 w-fit justify-end"><!> <!> <!></menu>'), pa = f("<p>Chat</p>"), ga = f("<!> <!>", 1), ma = f("<p>Threads</p>"), _a = f("<!> <!>", 1), ba = f("<!> <!>", 1), xa = f('<div class="navbar-end"><!></div>'), Ta = f('<header class="navbar"><div class="navbar-start flex gap-4"><!> <h4> </h4></div> <!> <!></header> <div class="divider my-0"></div> <!>', 1);
  Ja = function(_, t) {
    be(t, true);
    const p = (a) => {
      var s = ra();
      Ve(s, 21, () => Object.entries(e(B)), Le, (r, i, m, R) => {
        let u = () => e(i)[0], M = () => e(i)[1];
        var d = sa(), N = c(d), T = c(N), E = c(T, true);
        l(T);
        var X = v(T, 2);
        aa(X, u), l(N), l(d), ie(() => {
          bt(d, "href", `/space/${y.params.space}/thread/${u()}`), ge(E, M().title);
        }), n(r, d);
      }), l(s), n(a, s);
    }, C = (a) => {
      var s = Z(), r = D(s);
      {
        var i = (m) => {
          var R = la(), u = D(R);
          const M = h(() => ({
            type: "space",
            space: e(o)
          })), d = h(() => e(S)?.timeline ?? []);
          Bt(u, {
            get source() {
              return e(M);
            },
            get timeline() {
              return e(d);
            }
          });
          var N = v(u, 2), T = c(N);
          {
            var E = (I) => {
              var W = oa(), G = c(W);
              {
                var $ = (O) => {
                  var P = ia(), V = c(P), ae = c(V), ne = v(c(ae));
                  We(ne, {
                    get handle() {
                      return e(w).authorProfile.handle;
                    },
                    get avatarUrl() {
                      return e(w).authorProfile.avatarUrl;
                    },
                    className: "!w-4"
                  });
                  var ue = v(ne, 2), dt = c(ue, true);
                  l(ue), l(ae);
                  var Fe = v(ae, 2), ut = c(Fe);
                  gt(ut, () => Ft(e(w).content), false, false), l(Fe), l(V);
                  var vt = v(V, 2);
                  q(vt, () => pe, (ht, ft) => {
                    ft(ht, {
                      type: "button",
                      onclick: () => b(w, null),
                      class: "btn btn-circle btn-ghost",
                      children: (pt, ya) => {
                        le(pt, {
                          icon: "zondicons:close-solid"
                        });
                      },
                      $$slots: {
                        default: true
                      }
                    });
                  }), l(P), ie(() => ge(dt, e(w).authorProfile.handle)), n(O, P);
                };
                U(G, (O) => {
                  e(w) && O($);
                });
              }
              var j = v(G, 2), te = c(j);
              Nt(te, {
                get users() {
                  return se.value;
                },
                get context() {
                  return oe.value;
                },
                onEnter: ye,
                get content() {
                  return e(g);
                },
                set content(O) {
                  b(g, L(O));
                }
              }), l(j), l(W), n(I, W);
            };
            U(T, (I) => {
              (!e(k) || !K.value) && I(E);
            });
          }
          var X = v(T, 2);
          {
            var F = (I) => {
              H(I);
            };
            U(X, (I) => {
              e(k) && I(F);
            });
          }
          l(N), n(m, R);
        };
        U(r, (m) => {
          e(o) && m(i);
        });
      }
      n(a, s);
    }, H = (a) => {
      var s = fa(), r = c(s);
      q(r, () => Mt, (u, M) => {
        M(u, {
          get open() {
            return K.value;
          },
          set open(d) {
            K.value = d;
          },
          children: (d, N) => {
            var T = da(), E = D(T);
            q(E, () => Rt, (F, I) => {
              I(F, {
                children: (W, G) => {
                  le(W, {
                    icon: "tabler:needle-thread",
                    class: "text-2xl"
                  });
                },
                $$slots: {
                  default: true
                }
              });
            });
            var X = v(E, 2);
            q(X, () => $t, (F, I) => {
              I(F, {
                children: (W, G) => {
                  var $ = Z(), j = D($);
                  q(j, () => jt, (te, O) => {
                    O(te, {
                      side: "left",
                      sideOffset: 8,
                      interactOutsideBehavior: "ignore",
                      class: "my-4 bg-base-300 rounded py-4 px-5",
                      children: (P, V) => {
                        var ae = ca(), ne = c(ae);
                        Ue(ne), Ge(2), l(ae), ze("submit", ae, ce), Je(ne, () => e(re), (ue) => b(re, ue)), n(P, ae);
                      },
                      $$slots: {
                        default: true
                      }
                    });
                  }), n(W, $);
                },
                $$slots: {
                  default: true
                }
              });
            }), n(d, T);
          },
          $$slots: {
            default: true
          }
        });
      });
      var i = v(r, 2);
      q(i, () => pe, (u, M) => {
        M(u, {
          title: "Copy invite link",
          class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150",
          onclick: () => {
            navigator.clipboard.writeText(`${y.url.href}`);
          },
          children: (d, N) => {
            le(d, {
              icon: "icon-park-outline:copy-link",
              class: "text-2xl"
            });
          },
          $$slots: {
            default: true
          }
        });
      });
      var m = v(i, 2);
      {
        var R = (u) => {
          Vt(u, {
            title: "Channel Settings",
            get isDialogOpen() {
              return e(we);
            },
            set isDialogOpen(d) {
              b(we, L(d));
            },
            dialogTrigger: (d) => {
              var N = Z(), T = D(N);
              q(T, () => pe, (E, X) => {
                X(E, {
                  title: "Channel Settings",
                  class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex",
                  children: (F, I) => {
                    le(F, {
                      icon: "lucide:settings",
                      class: "text-2xl"
                    });
                  },
                  $$slots: {
                    default: true
                  }
                });
              }), n(d, N);
            },
            children: (d, N) => {
              var T = ha(), E = c(T), X = v(c(E));
              Ue(X), l(E);
              var F = v(E, 2);
              {
                var I = (G) => {
                  var $ = va(), j = c($);
                  j.value = (j.__value = void 0) == null ? "" : void 0;
                  var te = v(j);
                  Ve(te, 17, () => Object.keys(e(o).view.categories), Le, (O, P) => {
                    var V = ua();
                    const ae = h(() => e(o).view.categories[e(P)]);
                    var ne = {}, ue = c(V, true);
                    l(V), ie(() => {
                      ne !== (ne = e(P)) && (V.value = (V.__value = e(P)) == null ? "" : e(P)), ge(ue, e(ae).name);
                    }), n(O, V);
                  }), l($), Dt($, () => e(de), (O) => b(de, O)), n(G, $);
                };
                U(F, (G) => {
                  e(o) && G(I);
                });
              }
              var W = v(F, 2);
              q(W, () => pe, (G, $) => {
                $(G, {
                  class: "btn btn-primary",
                  children: (j, te) => {
                    Ge();
                    var O = mt("Save Settings");
                    n(j, O);
                  },
                  $$slots: {
                    default: true
                  }
                });
              }), l(T), ze("submit", T, et), Je(X, () => e(fe), (G) => b(fe, G)), n(d, T);
            },
            $$slots: {
              dialogTrigger: true,
              default: true
            }
          });
        };
        U(m, (u) => {
          Ze && u(R);
        });
      }
      l(s), n(a, s);
    };
    let k = h(() => (Gt.current ?? 0) < 640), ee = me("space"), o = h(() => ee.value), S = h(() => e(o)?.view.channels[y.params.channel]), se = me("users"), oe = me("contextItems"), B = h(() => {
      let a = {};
      return e(o) && e(S) && Object.entries(e(o).view.threads).map(([s, r]) => {
        !r.softDeleted && r.relatedChannel === y.params.channel && (a[s] = r);
      }), a;
    }), A = Y("chat"), g = Y(L({})), J = Y(null), K = L({
      value: false
    }), re = Y(""), x = Y(L([]));
    ve("isThreading", K), ve("selectMessage", (a) => {
      e(x).push(a);
    }), ve("removeSelectedMessage", (a) => {
      b(x, L(e(x).filter((s) => s != a)));
    }), ve("deleteMessage", (a) => {
      e(o) && e(o).change((s) => {
        Object.values(s.channels).forEach((r) => {
          const i = r.timeline.indexOf(a);
          i !== -1 && r.timeline.splice(i, 1);
        }), Object.values(s.threads).forEach((r) => {
          const i = r.timeline.indexOf(a);
          i !== -1 && r.timeline.splice(i, 1);
        }), delete s.messages[a];
      });
    }), Se(() => {
      !K.value && e(x).length > 0 && b(x, L([]));
    });
    let w = Y(void 0);
    ve("setReplyTo", (a) => {
      b(w, L(a));
    }), ve("toggleReaction", (a, s) => {
      e(o) && e(o).change((r) => {
        const i = ke.profile.data?.did;
        if (!i) return;
        let m = r.messages[a].reactions[s] ?? [];
        m.includes(i) ? r.messages[a].reactions[s].length - 1 === 0 ? delete r.messages[a].reactions[s] : r.messages[a].reactions[s] = m.filter((R) => R !== i) : (r.messages[a].reactions || (r.messages[a].reactions = {}), r.messages[a].reactions[s] = [
          ...m,
          i
        ]);
      });
    });
    function ce(a) {
      a.preventDefault(), !(!e(o) || !e(S)) && (e(o).change((s) => {
        const r = _e(), i = [];
        e(x).sort((u, M) => e(S).timeline.indexOf(u) - e(S).timeline.indexOf(M));
        for (const u of e(x)) {
          i.push(u);
          const M = e(S)?.timeline.indexOf(u);
          s.channels[y.params.channel].timeline.splice(M, 1);
          const d = _e(), N = {
            kind: "messageMoved",
            relatedMessages: [
              u
            ],
            relatedThreads: [
              r
            ],
            reactions: {}
          };
          s.messages[d] = N, s.channels[y.params.channel].timeline.splice(M, 0, d);
        }
        s.threads[r] = {
          title: e(re),
          timeline: i,
          relatedChannel: y.params.channel
        };
        const m = _e(), R = {
          kind: "threadCreated",
          relatedThreads: [
            r
          ],
          reactions: {}
        };
        s.messages[m] = R, s.channels[y.params.channel].timeline.push(m);
      }), b(re, ""), K.value = false, At.success("Thread created", {
        position: "bottom-end"
      }));
    }
    async function ye() {
      e(o) && (e(o).change((a) => {
        if (!ke.agent) return;
        const s = _e();
        a.messages[s] = {
          author: ke.agent.assertDid,
          reactions: {},
          content: JSON.stringify(e(g)),
          ...e(w) && {
            replyTo: e(w).id
          }
        }, a.channels[y.params.channel].timeline.push(s);
      }), b(g, L({})), b(w, null), b(J, null));
    }
    let { value: Ze } = me("isAdmin"), we = Y(false), fe = Y(""), de = Y(void 0);
    Se(() => {
      e(o) && (b(fe, L(e(S)?.name || "")), b(de, L(Object.entries(e(o).view.categories).find(([a, s]) => s.channels.includes(y.params.channel))?.[0])));
    });
    function et() {
      e(o)?.change((a) => {
        e(fe) && (a.channels[y.params.channel].name = e(fe)), Object.entries(a.categories).forEach(([s, r]) => {
          if (e(de) !== s) {
            const i = r.channels.indexOf(y.params.channel);
            i !== -1 && r.channels.splice(i, 1);
          }
          if (e(de)) {
            const i = a.categories[e(de)];
            i.channels.includes(y.params.channel) || i.channels.push(y.params.channel);
            const m = a.sidebarItems.findIndex((R) => R.type == "channel" && R.id == y.params.channel);
            m !== -1 && a.sidebarItems.splice(m, 1);
          } else a.sidebarItems.find((i) => i.type == "channel" && i.id == y.params.channel) || a.sidebarItems.push({
            type: "channel",
            id: y.params.channel
          });
        });
      }), b(we, false);
    }
    var Ee = Ta(), Ie = D(Ee), Pe = c(Ie), Be = c(Pe);
    {
      var tt = (a) => {
        var s = Z(), r = D(s);
        q(r, () => pe, (i, m) => {
          m(i, {
            onclick: () => Ke(`/space/${y.params.space}`),
            children: (R, u) => {
              le(R, {
                icon: "uil:left"
              });
            },
            $$slots: {
              default: true
            }
          });
        }), n(a, s);
      }, at = (a) => {
        const s = h(() => e(S)?.avatar), r = h(() => e(S)?.name ?? "");
        We(a, {
          get avatarUrl() {
            return e(s);
          },
          get handle() {
            return e(r);
          }
        });
      };
      U(Be, (a) => {
        e(k) ? a(tt) : a(at, false);
      });
    }
    var Ce = v(Be, 2), st = c(Ce, true);
    l(Ce), l(Pe);
    var Ne = v(Pe, 2);
    const rt = h(() => e(k) ? "navbar-end" : "navbar-center");
    q(Ne, () => Yt, (a, s) => {
      s(a, {
        get class() {
          return e(rt);
        },
        get value() {
          return e(A);
        },
        set value(r) {
          b(A, L(r));
        },
        children: (r, i) => {
          var m = Z(), R = D(m);
          q(R, () => ea, (u, M) => {
            M(u, {
              class: "tabs tabs-box",
              children: (d, N) => {
                var T = ba(), E = D(T);
                q(E, () => Qe, (F, I) => {
                  I(F, {
                    value: "chat",
                    onclick: () => Ke(y.url.pathname),
                    class: "tab flex gap-2",
                    children: (W, G) => {
                      var $ = ga(), j = D($);
                      le(j, {
                        icon: "tabler:message",
                        class: "text-2xl"
                      });
                      var te = v(j, 2);
                      {
                        var O = (P) => {
                          var V = pa();
                          n(P, V);
                        };
                        U(te, (P) => {
                          e(k) || P(O);
                        });
                      }
                      n(W, $);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                });
                var X = v(E, 2);
                q(X, () => Qe, (F, I) => {
                  I(F, {
                    value: "threads",
                    class: "tab flex gap-2",
                    children: (W, G) => {
                      var $ = _a(), j = D($);
                      le(j, {
                        icon: "material-symbols:thread-unread-rounded",
                        class: "text-2xl"
                      });
                      var te = v(j, 2);
                      {
                        var O = (P) => {
                          var V = ma();
                          n(P, V);
                        };
                        U(te, (P) => {
                          e(k) || P(O);
                        });
                      }
                      n(W, $);
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), n(d, T);
              },
              $$slots: {
                default: true
              }
            });
          }), n(r, m);
        },
        $$slots: {
          default: true
        }
      });
    });
    var nt = v(Ne, 2);
    {
      var it = (a) => {
        var s = xa(), r = c(s);
        H(r), l(s), n(a, s);
      };
      U(nt, (a) => {
        e(k) || a(it);
      });
    }
    l(Ie);
    var ot = v(Ie, 4);
    {
      var lt = (a) => {
        C(a);
      }, ct = (a) => {
        p(a);
      };
      U(ot, (a) => {
        e(A) === "chat" ? a(lt) : a(ct, false);
      });
    }
    ie(() => {
      _t(Ce, 1, `${e(k) && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`), ge(st, e(S)?.name);
    }), n(_, Ee), xe();
  };
});
export {
  __tla,
  Ja as component
};
