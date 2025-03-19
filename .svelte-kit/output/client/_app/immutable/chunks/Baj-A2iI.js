import { a6 as g, a7 as j, a8 as D, N as d, a9 as K, g as w, a5 as s, b as v, aa as h, K as T, ab as A, ac as E, O as L } from "./BMAj9zKA.js";
function o(n, y = null, M) {
  if (typeof n != "object" || n === null || g in n) return n;
  const N = E(n);
  if (N !== j && N !== D) return n;
  var a = /* @__PURE__ */ new Map(), b = L(n), m = d(0);
  b && a.set("length", d(n.length));
  var l;
  return new Proxy(n, { defineProperty(i, e, t) {
    (!("value" in t) || t.configurable === false || t.enumerable === false || t.writable === false) && A();
    var r = a.get(e);
    return r === void 0 ? (r = d(t.value), a.set(e, r)) : v(r, o(t.value, l)), true;
  }, deleteProperty(i, e) {
    var t = a.get(e);
    if (t === void 0) e in i && a.set(e, d(s));
    else {
      if (b && typeof e == "string") {
        var r = a.get("length"), f = Number(e);
        Number.isInteger(f) && f < r.v && v(r, f);
      }
      v(t, s), I(m);
    }
    return true;
  }, get(i, e, t) {
    if (e === g) return n;
    var r = a.get(e), f = e in i;
    if (r === void 0 && (!f || h(i, e)?.writable) && (r = d(o(f ? i[e] : s, l)), a.set(e, r)), r !== void 0) {
      var u = w(r);
      return u === s ? void 0 : u;
    }
    return Reflect.get(i, e, t);
  }, getOwnPropertyDescriptor(i, e) {
    var t = Reflect.getOwnPropertyDescriptor(i, e);
    if (t && "value" in t) {
      var r = a.get(e);
      r && (t.value = w(r));
    } else if (t === void 0) {
      var f = a.get(e), u = f?.v;
      if (f !== void 0 && u !== s) return { enumerable: true, configurable: true, value: u, writable: true };
    }
    return t;
  }, has(i, e) {
    if (e === g) return true;
    var t = a.get(e), r = t !== void 0 && t.v !== s || Reflect.has(i, e);
    if (t !== void 0 || T !== null && (!r || h(i, e)?.writable)) {
      t === void 0 && (t = d(r ? o(i[e], l) : s), a.set(e, t));
      var f = w(t);
      if (f === s) return false;
    }
    return r;
  }, set(i, e, t, r) {
    var f = a.get(e), u = e in i;
    if (b && e === "length") for (var c = t; c < f.v; c += 1) {
      var _ = a.get(c + "");
      _ !== void 0 ? v(_, s) : c in i && (_ = d(s), a.set(c + "", _));
    }
    f === void 0 ? (!u || h(i, e)?.writable) && (f = d(void 0), v(f, o(t, l)), a.set(e, f)) : (u = f.v !== s, v(f, o(t, l)));
    var O = Reflect.getOwnPropertyDescriptor(i, e);
    if (O?.set && O.set.call(r, t), !u) {
      if (b && typeof e == "string") {
        var P = a.get("length"), x = Number(e);
        Number.isInteger(x) && x >= P.v && v(P, x + 1);
      }
      I(m);
    }
    return true;
  }, ownKeys(i) {
    w(m);
    var e = Reflect.ownKeys(i).filter((f) => {
      var u = a.get(f);
      return u === void 0 || u.v !== s;
    });
    for (var [t, r] of a) r.v !== s && !(t in i) && e.push(t);
    return e;
  }, setPrototypeOf() {
    K();
  } });
}
function I(n, y = 1) {
  v(n, n.v + y);
}
function R(n) {
  return n !== null && typeof n == "object" && g in n ? n[g] : n;
}
function B(n, y) {
  return Object.is(R(n), R(y));
}
export {
  B as i,
  o as p
};
