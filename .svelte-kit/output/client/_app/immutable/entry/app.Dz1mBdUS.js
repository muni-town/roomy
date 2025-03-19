const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["../nodes/0.CzRkCcfC.js","../chunks/NZTpNUN0.js","../chunks/BMAj9zKA.js","../chunks/DIeogL5L.js","../chunks/pDBoOQRd.js","../chunks/k4NpJaFV.js","../nodes/1.C_ZS22dS.js","../chunks/69_IOA4Y.js","../chunks/DzGbYseb.js","../chunks/BSdt-dIf.js","../chunks/CrW2qrX9.js","../chunks/DMwpQjbe.js","../chunks/Be9Ooa0M.js","../chunks/BqahWDdA.js","../chunks/Dxu-ImQV.js","../nodes/2.BPnlBF5a.js","../nodes/3.Cfu1daWQ.js","../chunks/BA1UOs1h.js","../chunks/BuDgEN05.js","../chunks/BUHZJKy3.js","../chunks/DjDC-EQm.js","../chunks/BOaKtN8S.js","../chunks/Baj-A2iI.js","../chunks/D_-9kNr4.js","../chunks/BUkYaDtB.js","../chunks/D7Oepc1u.js","../chunks/BmvqXKNQ.js","../chunks/7tHZr1X2.js","../chunks/CmGwp3aM.js","../chunks/DfzdJtdG.js","../assets/Toaster.DLrpRFSn.css","../chunks/DcnaqaBM.js","../assets/3.DkKduhJA.css","../nodes/4.BpFZT5R3.js","../chunks/C8D1QxlH.js","../chunks/B9N9amIG.js","../nodes/5.C-Qcqcnt.js","../nodes/6.dR9rTBff.js","../nodes/7.DDO9ChKR.js","../nodes/8.BaSrdGzf.js","../nodes/9.B2My7pPV.js","../nodes/10.BgyovhU9.js","../chunks/6qt9xK2H.js","../assets/ChatInput.zQL3SrAm.css","../nodes/11.DraUVWJN.js"])))=>i.map(i=>d[i]);
import { b as N, ar as mt, g as c, aM as _t, al as dt, M as ft, p as vt, _ as ht, u as gt, d as J, aN as Et, f, s as yt, a as Pt, e as P, c as pt, r as Rt, t as bt } from "../chunks/BMAj9zKA.js";
import { h as Ot, m as Lt, u as At, s as wt } from "../chunks/DzGbYseb.js";
import "../chunks/NZTpNUN0.js";
import { i as C } from "../chunks/BA1UOs1h.js";
import { t as $, a as m, c as h, e as Tt } from "../chunks/pDBoOQRd.js";
import { c as p, b as R } from "../chunks/BUHZJKy3.js";
import { p as kt } from "../chunks/Baj-A2iI.js";
import { p as j } from "../chunks/D_-9kNr4.js";
import { o as Dt } from "../chunks/BqahWDdA.js";
let oe, Bt, re, ae, Nt, Zt, te, $t, ee;
let __tla = (async () => {
  function It(n) {
    return class extends Vt {
      constructor(t) {
        super({
          component: n,
          ...t
        });
      }
    };
  }
  class Vt {
    #e;
    #t;
    constructor(t) {
      var r = /* @__PURE__ */ new Map(), i = (a, e) => {
        var o = ft(e);
        return r.set(a, o), o;
      };
      const s = new Proxy({
        ...t.props || {},
        $$events: {}
      }, {
        get(a, e) {
          return c(r.get(e) ?? i(e, Reflect.get(a, e)));
        },
        has(a, e) {
          return e === mt ? true : (c(r.get(e) ?? i(e, Reflect.get(a, e))), Reflect.has(a, e));
        },
        set(a, e, o) {
          return N(r.get(e) ?? i(e, o), o), Reflect.set(a, e, o);
        }
      });
      this.#t = (t.hydrate ? Ot : Lt)(t.component, {
        target: t.target,
        anchor: t.anchor,
        props: s,
        context: t.context,
        intro: t.intro ?? false,
        recover: t.recover
      }), (!t?.props?.$$host || t.sync === false) && _t(), this.#e = s.$$events;
      for (const a of Object.keys(this.#t)) a === "$set" || a === "$destroy" || a === "$on" || dt(this, a, {
        get() {
          return this.#t[a];
        },
        set(e) {
          this.#t[a] = e;
        },
        enumerable: true
      });
      this.#t.$set = (a) => {
        Object.assign(s, a);
      }, this.#t.$destroy = () => {
        At(this.#t);
      };
    }
    $set(t) {
      this.#t.$set(t);
    }
    $on(t, r) {
      this.#e[t] = this.#e[t] || [];
      const i = (...s) => r.call(this, ...s);
      return this.#e[t].push(i), () => {
        this.#e[t] = this.#e[t].filter((s) => s !== i);
      };
    }
    $destroy() {
      this.#t.$destroy();
    }
  }
  let xt, St, Z, _;
  xt = "modulepreload";
  St = function(n, t) {
    return new URL(n, t).href;
  };
  Z = {};
  _ = function(t, r, i) {
    let s = Promise.resolve();
    if (r && r.length > 0) {
      const e = document.getElementsByTagName("link"), o = document.querySelector("meta[property=csp-nonce]"), w = o?.nonce || o?.getAttribute("nonce");
      s = Promise.allSettled(r.map((u) => {
        if (u = St(u, i), u in Z) return;
        Z[u] = true;
        const g = u.endsWith(".css"), M = g ? '[rel="stylesheet"]' : "";
        if (!!i) for (let E = e.length - 1; E >= 0; E--) {
          const b = e[E];
          if (b.href === u && (!g || b.rel === "stylesheet")) return;
        }
        else if (document.querySelector(`link[href="${u}"]${M}`)) return;
        const d = document.createElement("link");
        if (d.rel = g ? "stylesheet" : xt, g || (d.as = "script"), d.crossOrigin = "", d.href = u, w && d.setAttribute("nonce", w), document.head.appendChild(d), g) return new Promise((E, b) => {
          d.addEventListener("load", E), d.addEventListener("error", () => b(new Error(`Unable to preload CSS for ${u}`)));
        });
      }));
    }
    function a(e) {
      const o = new Event("vite:preloadError", {
        cancelable: true
      });
      if (o.payload = e, window.dispatchEvent(o), !o.defaultPrevented) throw e;
    }
    return s.then((e) => {
      for (const o of e || []) o.status === "rejected" && a(o.reason);
      return t().catch(a);
    });
  };
  Zt = {};
  var Ct = $('<div id="svelte-announcer" aria-live="assertive" aria-atomic="true" style="position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px"><!></div>'), jt = $("<!> <!>", 1);
  function Mt(n, t) {
    vt(t, true);
    let r = j(t, "components", 23, () => []), i = j(t, "data_0", 3, null), s = j(t, "data_1", 3, null), a = j(t, "data_2", 3, null), e = j(t, "data_3", 3, null);
    ht(() => t.stores.page.set(t.page)), gt(() => {
      t.stores, t.page, t.constructors, r(), t.form, i(), s(), a(), e(), t.stores.page.notify();
    });
    let o = J(false), w = J(false), u = J(null);
    Dt(() => {
      const l = t.stores.page.subscribe(() => {
        c(o) && (N(w, true), Et().then(() => {
          N(u, kt(document.title || "untitled page"));
        }));
      });
      return N(o, true), l;
    });
    const g = P(() => t.constructors[3]);
    var M = jt(), B = f(M);
    {
      var d = (l) => {
        var v = h();
        const T = P(() => t.constructors[0]);
        var k = f(v);
        p(k, () => c(T), (y, O) => {
          R(O(y, {
            get data() {
              return i();
            },
            get form() {
              return t.form;
            },
            children: (D, qt) => {
              var K = h(), et = f(K);
              {
                var rt = (L) => {
                  var I = h();
                  const q = P(() => t.constructors[1]);
                  var U = f(I);
                  p(U, () => c(q), (G, W) => {
                    R(W(G, {
                      get data() {
                        return s();
                      },
                      get form() {
                        return t.form;
                      },
                      children: (V, Ut) => {
                        var Q = h(), ot = f(Q);
                        {
                          var st = (A) => {
                            var x = h();
                            const Y = P(() => t.constructors[2]);
                            var z = f(x);
                            p(z, () => c(Y), (F, H) => {
                              R(H(F, {
                                get data() {
                                  return a();
                                },
                                get form() {
                                  return t.form;
                                },
                                children: (S, Gt) => {
                                  var X = h(), it = f(X);
                                  p(it, () => c(g), (ct, ut) => {
                                    R(ut(ct, {
                                      get data() {
                                        return e();
                                      },
                                      get form() {
                                        return t.form;
                                      }
                                    }), (lt) => r()[3] = lt, () => r()?.[3]);
                                  }), m(S, X);
                                },
                                $$slots: {
                                  default: true
                                }
                              }), (S) => r()[2] = S, () => r()?.[2]);
                            }), m(A, x);
                          }, nt = (A) => {
                            var x = h();
                            const Y = P(() => t.constructors[2]);
                            var z = f(x);
                            p(z, () => c(Y), (F, H) => {
                              R(H(F, {
                                get data() {
                                  return a();
                                },
                                get form() {
                                  return t.form;
                                }
                              }), (S) => r()[2] = S, () => r()?.[2]);
                            }), m(A, x);
                          };
                          C(ot, (A) => {
                            t.constructors[3] ? A(st) : A(nt, false);
                          });
                        }
                        m(V, Q);
                      },
                      $$slots: {
                        default: true
                      }
                    }), (V) => r()[1] = V, () => r()?.[1]);
                  }), m(L, I);
                }, at = (L) => {
                  var I = h();
                  const q = P(() => t.constructors[1]);
                  var U = f(I);
                  p(U, () => c(q), (G, W) => {
                    R(W(G, {
                      get data() {
                        return s();
                      },
                      get form() {
                        return t.form;
                      }
                    }), (V) => r()[1] = V, () => r()?.[1]);
                  }), m(L, I);
                };
                C(et, (L) => {
                  t.constructors[2] ? L(rt) : L(at, false);
                });
              }
              m(D, K);
            },
            $$slots: {
              default: true
            }
          }), (D) => r()[0] = D, () => r()?.[0]);
        }), m(l, v);
      }, E = (l) => {
        var v = h();
        const T = P(() => t.constructors[0]);
        var k = f(v);
        p(k, () => c(T), (y, O) => {
          R(O(y, {
            get data() {
              return i();
            },
            get form() {
              return t.form;
            }
          }), (D) => r()[0] = D, () => r()?.[0]);
        }), m(l, v);
      };
      C(B, (l) => {
        t.constructors[1] ? l(d) : l(E, false);
      });
    }
    var b = yt(B, 2);
    {
      var tt = (l) => {
        var v = Ct(), T = pt(v);
        {
          var k = (y) => {
            var O = Tt();
            bt(() => wt(O, c(u))), m(y, O);
          };
          C(T, (y) => {
            c(w) && y(k);
          });
        }
        Rt(v), m(l, v);
      };
      C(b, (l) => {
        c(o) && l(tt);
      });
    }
    m(n, M), Pt();
  }
  $t = It(Mt);
  te = [
    () => _(() => import("../nodes/0.CzRkCcfC.js"), __vite__mapDeps([0,1,2,3,4,5]), import.meta.url),
    () => _(() => import("../nodes/1.C_ZS22dS.js"), __vite__mapDeps([6,1,7,3,2,8,9,4,10,11,12,13,14]), import.meta.url),
    () => _(() => import("../nodes/2.BPnlBF5a.js"), __vite__mapDeps([15,0,1,2,3,4,5]), import.meta.url),
    () => _(() => import("../nodes/3.Cfu1daWQ.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([16,1,2,3,8,9,4,17,18,5,19,20,21,22,23,14,24,25,13,11,12,26,27,7,10,28,29,30,31,32]), import.meta.url),
    () => _(() => import("../nodes/4.BpFZT5R3.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([33,1,2,3,8,9,4,17,18,5,19,20,34,24,25,22,21,23,14,35,27,7,10,13,28,11,12,26,31]), import.meta.url),
    () => _(() => import("../nodes/5.C-Qcqcnt.js"), __vite__mapDeps([36,1,2,3,8,9,4,17,22,13,25]), import.meta.url),
    () => _(() => import("../nodes/6.dR9rTBff.js"), __vite__mapDeps([37,1,7,3]), import.meta.url),
    () => _(() => import("../nodes/7.DDO9ChKR.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([38,1,2,3,8,9,4,17,18,20,26,22,25,24]), import.meta.url),
    () => _(() => import("../nodes/8.BaSrdGzf.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([39,1,7,3,4,2,26,22,25,24]), import.meta.url),
    () => _(() => import("../nodes/9.B2My7pPV.js"), __vite__mapDeps([40,1,7,3,2,4,27,17,20,9,10,23,22,14,13]), import.meta.url),
    () => _(() => import("../nodes/10.BgyovhU9.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([41,1,2,3,8,9,4,17,18,27,7,20,10,23,22,14,13,19,21,5,24,25,35,11,12,29,30,42,34,43,28]), import.meta.url),
    () => _(() => import("../nodes/11.DraUVWJN.js").then(async (m2) => {
      await m2.__tla;
      return m2;
    }), __vite__mapDeps([44,1,2,3,8,9,4,17,27,7,20,10,23,22,14,13,19,21,5,24,25,11,12,29,30,42,18,34,43]), import.meta.url)
  ];
  ee = [];
  re = {
    "/(app)": [
      6,
      [
        3
      ]
    ],
    "/(app)/dev": [
      8,
      [
        3
      ]
    ],
    "/(app)/home": [
      7,
      [
        3
      ]
    ],
    "/(internal)/oauth/callback": [
      5,
      [
        2
      ]
    ],
    "/(app)/space/[space]": [
      9,
      [
        3,
        4
      ]
    ],
    "/(app)/space/[space]/thread/[thread]": [
      11,
      [
        3,
        4
      ]
    ],
    "/(app)/space/[space]/[channel]": [
      10,
      [
        3,
        4
      ]
    ]
  };
  Nt = {
    handleError: ({ error: n }) => {
      console.error(n);
    },
    init: void 0,
    reroute: () => {
    },
    transport: {}
  };
  Bt = Object.fromEntries(Object.entries(Nt.transport).map(([n, t]) => [
    n,
    t.decode
  ]));
  ae = false;
  oe = (n, t) => Bt[n](t);
})();
export {
  __tla,
  oe as decode,
  Bt as decoders,
  re as dictionary,
  ae as hash,
  Nt as hooks,
  Zt as matchers,
  te as nodes,
  $t as root,
  ee as server_loads
};
