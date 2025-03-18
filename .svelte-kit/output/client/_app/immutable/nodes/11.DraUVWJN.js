import "../chunks/NZTpNUN0.js";
import { p as ke, i as G, d as U, j, u as we, f as A, a as Me, g as e, b as f, e as B, c as l, s as d, r as c, t as re, n as je } from "../chunks/BMAj9zKA.js";
import { s as Y } from "../chunks/DzGbYseb.js";
import { i as I } from "../chunks/BA1UOs1h.js";
import { I as K, h as Ae } from "../chunks/7tHZr1X2.js";
import { t as g, a as m, c as ne } from "../chunks/pDBoOQRd.js";
import { c as O } from "../chunks/BUHZJKy3.js";
import { a as Be, s as Ee, r as Re } from "../chunks/DjDC-EQm.js";
import { e as De } from "../chunks/BSdt-dIf.js";
import { B as Z, P as Ne, b as Se, u as L, __tla as __tla_0 } from "../chunks/BOaKtN8S.js";
import { p as _ } from "../chunks/Baj-A2iI.js";
import { __tla as __tla_1 } from "../chunks/BUkYaDtB.js";
import { p as $ } from "../chunks/DMwpQjbe.js";
import { g as Ue } from "../chunks/Be9Ooa0M.js";
import { A as oe, t as ze, __tla as __tla_2 } from "../chunks/DfzdJtdG.js";
import { u as ee } from "../chunks/D7Oepc1u.js";
import { C as Fe, P as He, a as Je, b as We, c as qe, g as Ge, __tla as __tla_3 } from "../chunks/6qt9xK2H.js";
import { o as Ke, __tla as __tla_4 } from "../chunks/C8D1QxlH.js";
let yt;
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
  })()
]).then(async () => {
  var Le = g('<form class="flex flex-col gap-4"><input type="text" class="input px-2 py-1" placeholder="Thread Title"> <button type="submit" class="btn btn-primary">Create Thread</button></form>'), Qe = g("<!> <!>", 1), Ve = g('<menu class="relative flex items-center gap-3 px-2 w-fit justify-end"><!> <!></menu>'), Xe = g('<h4> </h4> <p class="text-gray-400 text-xs"></p> <a class="text-xs mention channel-mention"> </a>', 1), Ye = g('<div class="flex navbar-end"><!></div>'), Ze = g('<div class="flex justify-between bg-info text-info-content rounded-t-lg px-4 py-2"><div class="flex flex-col gap-1"><h5 class="flex gap-2 items-center">Replying to <!> <strong> </strong></h5> <p class="text-gray-300 text-ellipsis italic"><!></p></div> <!></div>'), et = g('<section class="grow flex flex-col"><!> <div class="relative"><!></div></section>'), tt = g('<!> <div class="flex"><!> <!></div>', 1), at = g('<header class="navbar"><div class="flex gap-4 navbar-start"><!> <!></div> <!></header> <div class="divider my-0"></div> <!>', 1);
  yt = function(ie, le) {
    ke(le, true);
    const te = (t) => {
      var a = Ve(), s = l(a);
      O(s, () => We, (n, i) => {
        i(n, {
          get open() {
            return k.value;
          },
          set open(o) {
            k.value = o;
          },
          children: (o, x) => {
            var y = Qe(), w = A(y);
            O(w, () => He, (P, M) => {
              M(P, {
                children: (R, H) => {
                  K(R, {
                    icon: "tabler:needle-thread",
                    class: "text-2xl"
                  });
                },
                $$slots: {
                  default: true
                }
              });
            });
            var h = d(w, 2);
            O(h, () => Ne, (P, M) => {
              M(P, {
                children: (R, H) => {
                  var J = ne(), C = A(J);
                  O(C, () => Je, (D, N) => {
                    N(D, {
                      side: "left",
                      sideOffset: 8,
                      interactOutsideBehavior: "ignore",
                      class: "my-4 bg-base-300 rounded py-4 px-5",
                      children: (S, X) => {
                        var T = Le(), W = l(T);
                        Re(W), je(2), c(T), De("submit", T, me), Se(W, () => e(F), (q) => f(F, q)), m(S, T);
                      },
                      $$slots: {
                        default: true
                      }
                    });
                  }), m(R, J);
                },
                $$slots: {
                  default: true
                }
              });
            }), m(o, y);
          },
          $$slots: {
            default: true
          }
        });
      });
      var r = d(s, 2);
      O(r, () => Z, (n, i) => {
        i(n, {
          title: "Copy invite link",
          class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150",
          onclick: () => {
            navigator.clipboard.writeText(`${$.url.href}`);
          },
          children: (o, x) => {
            K(o, {
              icon: "icon-park-outline:copy-link",
              class: "text-2xl"
            });
          },
          $$slots: {
            default: true
          }
        });
      }), c(a), m(t, a);
    };
    let E = B(() => (Ke.current ?? 0) < 640), ce = G("space"), v = B(() => ce.value), p = B(() => e(v)?.view.threads[$.params.thread]), de = G("users"), ve = G("contextItems");
    G("isAdmin");
    let z = U(_({})), pe = U(null), k = _({
      value: false
    }), F = U(""), b = U(_([]));
    j("isThreading", k), j("selectMessage", (t) => {
      e(b).push(t);
    }), j("removeSelectedMessage", (t) => {
      f(b, _(e(b).filter((a) => a != t)));
    }), j("deleteMessage", (t) => {
      e(v) && e(v).change((a) => {
        Object.values(a.channels).forEach((s) => {
          const r = s.timeline.indexOf(t);
          r !== -1 && s.timeline.splice(r, 1);
        }), Object.values(a.threads).forEach((s) => {
          const r = s.timeline.indexOf(t);
          r !== -1 && s.timeline.splice(r, 1);
        }), delete a.messages[t];
      });
    }), we(() => {
      !k.value && e(b).length > 0 && f(b, _([]));
    });
    let u = U(void 0);
    j("setReplyTo", (t) => {
      f(u, _(t));
    }), j("toggleReaction", (t, a) => {
      e(v) && e(v).change((s) => {
        const r = ee.profile.data?.did;
        if (!r) return;
        let n = s.messages[t].reactions[a] ?? [];
        n.includes(r) ? s.messages[t].reactions[a].length - 1 === 0 ? delete s.messages[t].reactions[a] : s.messages[t].reactions[a] = n.filter((i) => i !== r) : (s.messages[t].reactions || (s.messages[t].reactions = {}), s.messages[t].reactions[a] = [
          ...n,
          r
        ]);
      });
    });
    function me(t) {
      t.preventDefault(), !(!e(v) || !e(p)) && (e(v).change((a) => {
        const s = L(), r = [];
        e(b).sort((o, x) => e(p).timeline.indexOf(o) - e(p).timeline.indexOf(x));
        for (const o of e(b)) {
          r.push(o);
          const x = e(p)?.timeline.indexOf(o);
          a.threads[$.params.thread].timeline.splice(x, 1);
          const y = L(), w = {
            kind: "messageMoved",
            relatedMessages: [
              o
            ],
            relatedThreads: [
              s
            ],
            reactions: {}
          };
          a.messages[y] = w, a.threads[$.params.thread].timeline.splice(x, 0, y);
        }
        a.threads[s] = {
          title: e(F),
          timeline: r,
          relatedChannel: e(p).relatedChannel
        };
        const n = L(), i = {
          kind: "threadCreated",
          relatedThreads: [
            s
          ],
          reactions: {}
        };
        a.messages[n] = i, a.threads[$.params.thread].timeline.push(n);
      }), f(F, ""), k.value = false, ze.success("Thread created", {
        position: "bottom-end"
      }));
    }
    async function ue() {
      e(v) && (e(v).change((t) => {
        if (!ee.agent) return;
        const a = L();
        t.messages[a] = {
          author: ee.agent.assertDid,
          reactions: {},
          content: JSON.stringify(e(z)),
          ...e(u) && {
            replyTo: e(u).id
          }
        }, t.threads[$.params.thread].timeline.push(a);
      }), f(z, _({})), f(u, null), f(pe, null));
    }
    var ae = at(), Q = A(ae), V = l(Q), se = l(V);
    {
      var fe = (t) => {
        var a = ne(), s = A(a);
        O(s, () => Z, (r, n) => {
          n(r, {
            onclick: () => Ue(`/space/${$.params.space}`),
            children: (i, o) => {
              K(i, {
                icon: "uil:left"
              });
            },
            $$slots: {
              default: true
            }
          });
        }), m(t, a);
      }, he = (t) => {
        const a = B(() => e(p)?.title ?? "");
        oe(t, {
          get handle() {
            return e(a);
          }
        });
      };
      I(se, (t) => {
        e(E) ? t(fe) : t(he, false);
      });
    }
    var ge = d(se, 2);
    {
      var xe = (t) => {
        var a = Xe(), s = A(a), r = l(s, true);
        c(s);
        var n = d(s, 2);
        n.textContent = ">";
        var i = d(n, 2), o = l(i, true);
        c(i), re(() => {
          Be(s, 1, `${e(E) && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`), Y(r, e(p).title), Ee(i, "href", `/space/${$.params.space}/${e(p).relatedChannel}`), Y(o, e(v).view.channels[e(p).relatedChannel].name);
        }), m(t, a);
      };
      I(ge, (t) => {
        e(v) && e(p) && t(xe);
      });
    }
    c(V);
    var _e = d(V, 2);
    {
      var $e = (t) => {
        var a = Ye(), s = l(a);
        te(s), c(a), m(t, a);
      };
      I(_e, (t) => {
        e(E) || t($e);
      });
    }
    c(Q);
    var be = d(Q, 4);
    {
      var ye = (t) => {
        var a = tt(), s = A(a);
        const r = B(() => ({
          type: "space",
          space: e(v)
        })), n = B(() => e(p)?.timeline ?? []);
        Fe(s, {
          get source() {
            return e(r);
          },
          get timeline() {
            return e(n);
          }
        });
        var i = d(s, 2), o = l(i);
        {
          var x = (h) => {
            var P = et(), M = l(P);
            {
              var R = (C) => {
                var D = Ze(), N = l(D), S = l(N), X = d(l(S));
                oe(X, {
                  get handle() {
                    return e(u).authorProfile.handle;
                  },
                  get avatarUrl() {
                    return e(u).authorProfile.avatarUrl;
                  },
                  className: "!w-4"
                });
                var T = d(X, 2), W = l(T, true);
                c(T), c(S);
                var q = d(S, 2), Pe = l(q);
                Ae(Pe, () => Ge(e(u).content), false, false), c(q), c(N);
                var Ce = d(N, 2);
                O(Ce, () => Z, (Te, Ie) => {
                  Ie(Te, {
                    type: "button",
                    onclick: () => f(u, null),
                    class: "cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150",
                    children: (Oe, st) => {
                      K(Oe, {
                        icon: "zondicons:close-solid"
                      });
                    },
                    $$slots: {
                      default: true
                    }
                  });
                }), c(D), re(() => Y(W, e(u).authorProfile.handle)), m(C, D);
              };
              I(M, (C) => {
                e(u) && C(R);
              });
            }
            var H = d(M, 2), J = l(H);
            qe(J, {
              get users() {
                return de.value;
              },
              get context() {
                return ve.value;
              },
              onEnter: ue,
              get content() {
                return e(z);
              },
              set content(C) {
                f(z, _(C));
              }
            }), c(H), c(P), m(h, P);
          };
          I(o, (h) => {
            (!e(E) || !k.value) && h(x);
          });
        }
        var y = d(o, 2);
        {
          var w = (h) => {
            te(h);
          };
          I(y, (h) => {
            e(E) && h(w);
          });
        }
        c(i), m(t, a);
      };
      I(be, (t) => {
        e(v) && t(ye);
      });
    }
    m(ie, ae), Me();
  };
});
export {
  __tla,
  yt as component
};
