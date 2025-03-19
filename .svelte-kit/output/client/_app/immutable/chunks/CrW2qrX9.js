import { Z as d, _ as g, u as i, $ as l, a0 as m, a1 as b, g as p, a2 as v, e as h } from "./BMAj9zKA.js";
function x(n = false) {
  const s = d, e = s.l.u;
  if (!e) return;
  let f = () => v(s.s);
  if (n) {
    let a = 0, t = {};
    const _ = h(() => {
      let c = false;
      const r = s.s;
      for (const o in r) r[o] !== t[o] && (t[o] = r[o], c = true);
      return c && a++, a;
    });
    f = () => p(_);
  }
  e.b.length && g(() => {
    u(s, f), l(e.b);
  }), i(() => {
    const a = m(() => e.m.map(b));
    return () => {
      for (const t of a) typeof t == "function" && t();
    };
  }), e.a.length && i(() => {
    u(s, f), l(e.a);
  });
}
function u(n, s) {
  if (n.l.s) for (const e of n.l.s) p(e);
  s();
}
export {
  x as i
};
