import "../chunks/NZTpNUN0.js";
import { p as g, f as s, a as u, b as d, d as v, g as i, c as _, r as x, n as b, t as w } from "../chunks/BMAj9zKA.js";
import { s as k } from "../chunks/DzGbYseb.js";
import { i as y } from "../chunks/BA1UOs1h.js";
import { c as A, a as p, t as P } from "../chunks/pDBoOQRd.js";
import { p as S } from "../chunks/Baj-A2iI.js";
import { o as E } from "../chunks/BqahWDdA.js";
import { a as m, u as G } from "../chunks/D7Oepc1u.js";
var H = P('<p> </p> <p><a href="/">Go Home</a></p>', 1);
function q(n, c) {
  g(c, true);
  let r = v("");
  E(async () => {
    await m.init();
    const t = new URL(globalThis.location.href).searchParams;
    m.oauth.callback(t).then((a) => {
      G.session = a.session, window.location.href = localStorage.getItem("redirectAfterAuth") || "/";
    }).catch((a) => {
      d(r, S(a.toString()));
    });
  });
  var o = A(), f = s(o);
  {
    var l = (t) => {
      var a = H(), e = s(a), h = _(e);
      x(e), b(2), w(() => k(h, `Error logging in: ${i(r) ?? ""}.`)), p(t, a);
    };
    y(f, (t) => {
      i(r) && t(l);
    });
  }
  p(n, o), u();
}
export {
  q as component
};
