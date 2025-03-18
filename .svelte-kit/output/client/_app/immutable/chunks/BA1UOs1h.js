import { k as p, q as u, z as g, E as S, a4 as h, H as k, B as D, x as F, C as I, F as v, l as b, G as A, a5 as H, v as q } from "./BMAj9zKA.js";
function L(E, m, [t, s] = [0, 0]) {
  u && t === 0 && g();
  var a = E, f = null, e = null, i = H, N = t > 0 ? S : 0, c = false;
  const R = (n, l = true) => {
    c = true, o(l, n);
  }, o = (n, l) => {
    if (i === (i = n)) return;
    let T = false;
    if (u && s !== -1) {
      if (t === 0) {
        const r = a.data;
        r === h ? s = 0 : r === k ? s = 1 / 0 : (s = parseInt(r.substring(1)), s !== s && (s = i ? 1 / 0 : -1));
      }
      const _ = s > t;
      !!i === _ && (a = D(), F(a), I(false), T = true, s = -1);
    }
    i ? (f ? v(f) : l && (f = b(() => l(a))), e && A(e, () => {
      e = null;
    })) : (e ? v(e) : l && (e = b(() => l(a, [t + 1, s]))), f && A(f, () => {
      f = null;
    })), T && I(true);
  };
  p(() => {
    c = false, m(R), c || o(null, null);
  }, N), u && (a = q);
}
export {
  L as i
};
