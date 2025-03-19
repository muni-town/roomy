import "../chunks/NZTpNUN0.js";
import { p as Y, a as q, c as s, s as n, g as t, e as w, r as e, f as y, t as z } from "../chunks/BMAj9zKA.js";
import { s as C } from "../chunks/DzGbYseb.js";
import { i as S } from "../chunks/BA1UOs1h.js";
import { e as D, i as E } from "../chunks/BuDgEN05.js";
import { t as i, a as r, c as G } from "../chunks/pDBoOQRd.js";
import { s as I } from "../chunks/DjDC-EQm.js";
import { g as j, __tla as __tla_0 } from "../chunks/BmvqXKNQ.js";
let ea;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  var K = i('<div class="card card-dash bg-base-100 w-96"><div class="card-body"><h2 class="card-title"> </h2> <div class="card-actions justify-end"><a class="btn btn-primary">Join Space</a></div></div></div>'), L = i('<h2 class="text-3xl font-bold">Your Spaces</h2> <section class="flex gap-4 flex-wrap justify-center max-w-5xl"></section>', 1), M = i("<p>No servers found.</p>"), O = i(`<header class="hero bg-base-200 min-h-screen"><div class="hero-content"><div class="flex flex-col gap-8 items-center"><h1 class="text-5xl font-bold">Hello Roomy</h1> <p class="text-lg font-medium max-w-2xl text-center">A digital gardening platform for communities. Built on the AT Protocol. 
        Flourish in Spaces, curating knowledge and conversations together.</p> <div class="divider"></div> <!></div></div></header>`);
  ea = function(k, A) {
    Y(A, true);
    let p = w(() => j.catalog?.view.spaces.map((a) => a.id) || []);
    var c = O(), m = s(c), f = s(m), B = n(s(f), 6);
    {
      var F = (a) => {
        var o = L(), h = n(y(o), 2);
        D(h, 21, () => t(p), E, (J, g) => {
          var x = G();
          const _ = w(() => j.spaces[t(g)]);
          var N = y(x);
          {
            var P = (d) => {
              var l = K(), u = s(l), v = s(u), R = s(v, true);
              e(v);
              var b = n(v, 2), T = s(b);
              e(b), e(u), e(l), z(() => {
                C(R, t(_).view.name), I(T, "href", `/space/${t(g)}`);
              }), r(d, l);
            };
            S(N, (d) => {
              t(_) && d(P);
            });
          }
          r(J, x);
        }), e(h), r(a, o);
      }, H = (a) => {
        var o = M();
        r(a, o);
      };
      S(B, (a) => {
        t(p).length > 0 ? a(F) : a(H, false);
      });
    }
    e(f), e(m), e(c), r(k, c), q();
  };
});
export {
  __tla,
  ea as component
};
