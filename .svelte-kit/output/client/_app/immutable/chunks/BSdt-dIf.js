import { W as y, aF as l, aG as f, aH as E, K as g, ak as A, al as P, O as V, q as x } from "./BMAj9zKA.js";
function D(e) {
  return e.endsWith("capture") && e !== "gotpointercapture" && e !== "lostpointercapture";
}
const I = ["beforeinput", "click", "change", "dblclick", "contextmenu", "focusin", "focusout", "input", "keydown", "keyup", "mousedown", "mousemove", "mouseout", "mouseover", "mouseup", "pointerdown", "pointermove", "pointerout", "pointerover", "pointerup", "touchend", "touchmove", "touchstart"];
function R(e) {
  return I.includes(e);
}
const M = { formnovalidate: "formNoValidate", ismap: "isMap", nomodule: "noModule", playsinline: "playsInline", readonly: "readOnly", defaultvalue: "defaultValue", defaultchecked: "defaultChecked", srcobject: "srcObject", novalidate: "noValidate", allowfullscreen: "allowFullscreen", disablepictureinpicture: "disablePictureInPicture", disableremoteplayback: "disableRemotePlayback" };
function F(e) {
  return e = e.toLowerCase(), M[e] ?? e;
}
const N = ["touchstart", "touchmove"];
function G(e) {
  return N.includes(e);
}
const O = ["textarea", "script", "style", "title"];
function z(e) {
  return O.includes(e);
}
function H(e, t) {
  if (t) {
    const a = document.body;
    e.autofocus = true, y(() => {
      document.activeElement === a && e.focus();
    });
  }
}
let b = false;
function W() {
  b || (b = true, document.addEventListener("reset", (e) => {
    Promise.resolve().then(() => {
      if (!e.defaultPrevented) for (const t of e.target.elements) t.__on_r?.();
    });
  }, { capture: true }));
}
function w(e) {
  var t = E, a = g;
  l(null), f(null);
  try {
    return e();
  } finally {
    l(t), f(a);
  }
}
function K(e, t, a, o = a) {
  e.addEventListener(t, () => w(a));
  const n = e.__on_r;
  n ? e.__on_r = () => {
    n(), o(true);
  } : e.__on_r = () => o(true), W();
}
const q = /* @__PURE__ */ new Set(), j = /* @__PURE__ */ new Set();
function U(e) {
  if (!x) return;
  e.onload && e.removeAttribute("onload"), e.onerror && e.removeAttribute("onerror");
  const t = e.__e;
  t !== void 0 && (e.__e = void 0, queueMicrotask(() => {
    e.isConnected && e.dispatchEvent(t);
  }));
}
function k(e, t, a, o = {}) {
  function n(r) {
    if (o.capture || B.call(t, r), !r.cancelBubble) return w(() => a?.call(this, r));
  }
  return e.startsWith("pointer") || e.startsWith("touch") || e === "wheel" ? y(() => {
    t.addEventListener(e, n, o);
  }) : t.addEventListener(e, n, o), n;
}
function X(e, t, a, o = {}) {
  var n = k(t, e, a, o);
  return () => {
    e.removeEventListener(t, n, o);
  };
}
function J(e, t, a, o, n) {
  var r = { capture: o, passive: n }, i = k(e, t, a, r);
  (t === document.body || t === window || t === document) && A(() => {
    t.removeEventListener(e, i, r);
  });
}
function Q(e) {
  for (var t = 0; t < e.length; t++) q.add(e[t]);
  for (var a of j) a(e);
}
function B(e) {
  var t = this, a = t.ownerDocument, o = e.type, n = e.composedPath?.() || [], r = n[0] || e.target, i = 0, v = e.__root;
  if (v) {
    var _ = n.indexOf(v);
    if (_ !== -1 && (t === document || t === window)) {
      e.__root = t;
      return;
    }
    var p = n.indexOf(t);
    if (p === -1) return;
    _ <= p && (i = _);
  }
  if (r = n[i] || e.target, r !== t) {
    P(e, "currentTarget", { configurable: true, get() {
      return r || a;
    } });
    var m = E, T = g;
    l(null), f(null);
    try {
      for (var u, h = []; r !== null; ) {
        var d = r.assignedSlot || r.parentNode || r.host || null;
        try {
          var s = r["__" + o];
          if (s != null && (!r.disabled || e.target === r)) if (V(s)) {
            var [L, ...S] = s;
            L.apply(r, [e, ...S]);
          } else s.call(r, e);
        } catch (c) {
          u ? h.push(c) : u = c;
        }
        if (e.cancelBubble || d === t || d === null) break;
        r = d;
      }
      if (u) {
        for (let c of h) queueMicrotask(() => {
          throw c;
        });
        throw u;
      }
    } finally {
      e.__root = t, delete e.currentTarget, l(m), f(T);
    }
  }
}
export {
  q as a,
  D as b,
  k as c,
  Q as d,
  J as e,
  H as f,
  W as g,
  B as h,
  G as i,
  R as j,
  U as k,
  K as l,
  z as m,
  F as n,
  X as o,
  j as r,
  w
};
