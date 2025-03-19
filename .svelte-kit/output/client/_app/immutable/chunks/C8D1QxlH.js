import { K as I, E as z, aO as L, aP as M, h as B, a0 as q, aQ as G, aw as K, W as j, m as b, aF as C, aG as P, aH as H, aR as Q, aS as V } from "./BMAj9zKA.js";
import { a as D } from "./DzGbYseb.js";
import { w as J, o as X } from "./BSdt-dIf.js";
import { c as Y, __tla as __tla_0 } from "./BUkYaDtB.js";
import { p as Z } from "./Baj-A2iI.js";
import { u as U } from "./D7Oepc1u.js";
let dt, vt, ut;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  const $ = () => performance.now(), u = {
    tick: (r) => requestAnimationFrame(r),
    now: () => $(),
    tasks: /* @__PURE__ */ new Set()
  };
  function x() {
    const r = u.now();
    u.tasks.forEach((t) => {
      t.c(r) || (u.tasks.delete(t), t.f());
    }), u.tasks.size !== 0 && u.tick(x);
  }
  function tt(r) {
    let t;
    return u.tasks.size === 0 && u.tick(x), {
      promise: new Promise((a) => {
        u.tasks.add(t = {
          c: r,
          f: a
        });
      }),
      abort() {
        u.tasks.delete(t);
      }
    };
  }
  function E(r, t) {
    J(() => {
      r.dispatchEvent(new CustomEvent(t));
    });
  }
  function rt(r) {
    if (r === "float") return "cssFloat";
    if (r === "offset") return "cssOffset";
    if (r.startsWith("--")) return r;
    const t = r.split("-");
    return t.length === 1 ? t[0] : t[0] + t.slice(1).map((a) => a[0].toUpperCase() + a.slice(1)).join("");
  }
  function W(r) {
    const t = {}, a = r.split(";");
    for (const i of a) {
      const [e, s] = i.split(":");
      if (!e || s === void 0) break;
      const f = rt(e.trim());
      t[f] = s.trim();
    }
    return t;
  }
  const at = (r) => r;
  ut = function(r, t, a, i) {
    var e = (r & Q) !== 0, s = (r & V) !== 0, f = e && s, m = (r & G) !== 0, N = f ? "both" : e ? "in" : "out", v, d = t.inert, k = t.style.overflow, c, p;
    function h() {
      var w = H, T = I;
      C(null), P(null);
      try {
        return v ??= a()(t, i?.() ?? {}, {
          direction: N
        });
      } finally {
        C(w), P(T);
      }
    }
    var n = {
      is_global: m,
      in() {
        if (t.inert = d, !e) {
          p?.abort(), p?.reset?.();
          return;
        }
        s || c?.abort(), E(t, "introstart"), c = A(t, h(), p, 1, () => {
          E(t, "introend"), c?.abort(), c = v = void 0, t.style.overflow = k;
        });
      },
      out(w) {
        if (!s) {
          w?.(), v = void 0;
          return;
        }
        t.inert = true, E(t, "outrostart"), p = A(t, h(), c, 0, () => {
          E(t, "outroend"), w?.();
        });
      },
      stop: () => {
        c?.abort(), p?.abort();
      }
    }, _ = I;
    if ((_.transitions ??= []).push(n), e && D) {
      var l = m;
      if (!l) {
        for (var o = _.parent; o && (o.f & z) !== 0; ) for (; (o = o.parent) && (o.f & L) === 0; ) ;
        l = !o || (o.f & M) !== 0;
      }
      l && B(() => {
        q(() => n.in());
      });
    }
  };
  function A(r, t, a, i, e) {
    var s = i === 1;
    if (K(t)) {
      var f, m = false;
      return j(() => {
        if (!m) {
          var _ = t({
            direction: s ? "in" : "out"
          });
          f = A(r, _, a, i, e);
        }
      }), {
        abort: () => {
          m = true, f?.abort();
        },
        deactivate: () => f.deactivate(),
        reset: () => f.reset(),
        t: () => f.t()
      };
    }
    if (a?.deactivate(), !t?.duration) return e(), {
      abort: b,
      deactivate: b,
      reset: b,
      t: () => i
    };
    const { delay: N = 0, css: v, tick: d, easing: k = at } = t;
    var c = [];
    if (s && a === void 0 && (d && d(0, 1), v)) {
      var p = W(v(0, 1));
      c.push(p, p);
    }
    var h = () => 1 - i, n = r.animate(c, {
      duration: N
    });
    return n.onfinish = () => {
      var _ = a?.t() ?? 1 - i;
      a?.abort();
      var l = i - _, o = t.duration * Math.abs(l), w = [];
      if (o > 0) {
        var T = false;
        if (v) for (var O = Math.ceil(o / 16.666666666666668), F = 0; F <= O; F += 1) {
          var R = _ + l * k(F / O), S = W(v(R, 1 - R));
          w.push(S), T ||= S.overflow === "hidden";
        }
        T && (r.style.overflow = "hidden"), h = () => {
          var y = n.currentTime;
          return _ + l * k(y / o);
        }, d && tt(() => {
          if (n.playState !== "running") return false;
          var y = h();
          return d(y, 1 - y), true;
        });
      }
      n = r.animate(w, {
        duration: o,
        fill: "forwards"
      }), n.onfinish = () => {
        h = () => i, d?.(i, 1 - i), e();
      };
    }, {
      abort: () => {
        n && (n.cancel(), n.effect = null, n.onfinish = b);
      },
      deactivate: () => {
        e = b;
      },
      reset: () => {
        i === 0 && d?.(1, 0);
      },
      t: () => h()
    };
  }
  class it {
    #t;
    #r;
    constructor(t, a) {
      this.#t = t, this.#r = Y(a);
    }
    get current() {
      return this.#r(), this.#t();
    }
  }
  vt = new it(() => window.outerWidth, (r) => X(window, "resize", r));
  let g = Z({});
  dt = function(r) {
    q(() => g), g[r] || (g[r] = {
      handle: "",
      avatarUrl: "",
      new: true
    });
    const t = g[r];
    return queueMicrotask(() => {
      t.new == true && (t.new = false, U.agent && U.agent.getProfile({
        actor: r
      }).then(async (a) => {
        a.success && (t.handle = a.data.handle, t.avatarUrl = a.data.avatar || "");
      }));
    }), t;
  };
});
export {
  __tla,
  dt as g,
  vt as o,
  ut as t
};
