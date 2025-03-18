import { k as u, q as c, z as h, E as d, l as E, G as T, v as b, h as k, ad as v, a0 as y, W as A, a6 as S } from "./BMAj9zKA.js";
function x(r, f, i) {
  c && h();
  var t = r, s, a;
  u(() => {
    s !== (s = f()) && (a && (T(a), a = null), s && (a = E(() => i(t, s))));
  }, d), c && (t = b);
}
function n(r, f) {
  return r === f || r?.[S] === f;
}
function F(r = {}, f, i, t) {
  return k(() => {
    var s, a;
    return v(() => {
      s = a, a = [], y(() => {
        r !== i(...a) && (f(r, ...a), s && n(i(...s), r) && f(null, ...s));
      });
    }), () => {
      A(() => {
        a && n(i(...a), r) && f(null, ...a);
      });
    };
  }), r;
}
export {
  F as b,
  x as c
};
