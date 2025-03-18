import { q as p, C as j, aI as Y, ac as y, aJ as z, aK as D, aL as G } from "./BMAj9zKA.js";
import { b as J, c as F, d as Q, f as W, n as X, g as Z, j as m } from "./BSdt-dIf.js";
function R(r) {
  var s, f, i = "";
  if (typeof r == "string" || typeof r == "number") i += r;
  else if (typeof r == "object") if (Array.isArray(r)) {
    var t = r.length;
    for (s = 0; s < t; s++) r[s] && (f = R(r[s])) && (i && (i += " "), i += f);
  } else for (f in r) r[f] && (i && (i += " "), i += f);
  return i;
}
function x() {
  for (var r, s, f = 0, i = "", t = arguments.length; f < t; f++) (r = arguments[f]) && (s = R(r)) && (i && (i += " "), i += s);
  return i;
}
function rr(r) {
  return typeof r == "object" ? x(r) : r ?? "";
}
const w = [...` 	
\r\f\xA0\v\uFEFF`];
function fr(r, s, f) {
  var i = r == null ? "" : "" + r;
  if (s && (i = i ? i + " " + s : s), f) {
    for (var t in f) if (f[t]) i = i ? i + " " + t : t;
    else if (i.length) for (var u = t.length, l = 0; (l = i.indexOf(t, l)) >= 0; ) {
      var c = l + u;
      (l === 0 || w.includes(i[l - 1])) && (c === i.length || w.includes(i[c])) ? i = (l === 0 ? "" : i.substring(0, l)) + i.substring(c + 1) : l = c;
    }
  }
  return i === "" ? null : i;
}
function P(r, s = false) {
  var f = s ? " !important;" : ";", i = "";
  for (var t in r) {
    var u = r[t];
    u != null && u !== "" && (i += " " + t + ": " + u + f);
  }
  return i;
}
function O(r) {
  return r[0] !== "-" || r[1] !== "-" ? r.toLowerCase() : r;
}
function ir(r, s) {
  if (s) {
    var f = "", i, t;
    if (Array.isArray(s) ? (i = s[0], t = s[1]) : i = s, r) {
      r = String(r).replaceAll(/\s*\/\*.*?\*\/\s*/g, "").trim();
      var u = false, l = 0, c = false, A = [];
      i && A.push(...Object.keys(i).map(O)), t && A.push(...Object.keys(t).map(O));
      var o = 0, b = -1;
      const S = r.length;
      for (var n = 0; n < S; n++) {
        var g = r[n];
        if (c ? g === "/" && r[n - 1] === "*" && (c = false) : u ? u === g && (u = false) : g === "/" && r[n + 1] === "*" ? c = true : g === '"' || g === "'" ? u = g : g === "(" ? l++ : g === ")" && l--, !c && u === false && l === 0) {
          if (g === ":" && b === -1) b = n;
          else if (g === ";" || n === S - 1) {
            if (b !== -1) {
              var E = O(r.substring(o, b).trim());
              if (!A.includes(E)) {
                g !== ";" && n++;
                var T = r.substring(o, n).trim();
                f += " " + T + ";";
              }
            }
            o = n + 1, b = -1;
          }
        }
      }
    }
    return i && (f += P(i)), t && (f += P(t, true)), f = f.trim(), f === "" ? null : f;
  }
  return r == null ? null : String(r);
}
function sr(r, s, f, i, t, u) {
  var l = r.__className;
  if (p || l !== f) {
    var c = fr(f, i, u);
    (!p || c !== r.getAttribute("class")) && (c == null ? r.removeAttribute("class") : s ? r.className = c : r.setAttribute("class", c)), r.__className = f;
  } else if (u && t !== u) for (var A in u) {
    var o = !!u[A];
    (t == null || o !== !!t[A]) && r.classList.toggle(A, o);
  }
  return u;
}
function M(r, s = {}, f, i) {
  for (var t in f) {
    var u = f[t];
    s[t] !== u && (f[t] == null ? r.style.removeProperty(t) : r.style.setProperty(t, u, i));
  }
}
function tr(r, s, f, i) {
  var t = r.__style;
  if (p || t !== s) {
    var u = ir(s, i);
    (!p || u !== r.getAttribute("style")) && (u == null ? r.removeAttribute("style") : r.style.cssText = u), r.__style = s;
  } else i && (Array.isArray(i) ? (M(r, f?.[0], i[0]), M(r, f?.[1], i[1], "important")) : M(r, f, i));
  return i;
}
const N = Symbol("class"), L = Symbol("style"), U = Symbol("is custom element"), V = Symbol("is html");
function lr(r) {
  if (p) {
    var s = false, f = () => {
      if (!s) {
        if (s = true, r.hasAttribute("value")) {
          var i = r.value;
          C(r, "value", null), r.value = i;
        }
        if (r.hasAttribute("checked")) {
          var t = r.checked;
          C(r, "checked", null), r.checked = t;
        }
      }
    };
    r.__on_r = f, D(f), Z();
  }
}
function ur(r, s) {
  s ? r.hasAttribute("selected") || r.setAttribute("selected", "") : r.removeAttribute("selected");
}
function C(r, s, f, i) {
  var t = q(r);
  p && (t[s] = r.getAttribute(s), s === "src" || s === "srcset" || s === "href" && r.nodeName === "LINK") || t[s] !== (t[s] = f) && (s === "loading" && (r[z] = f), f == null ? r.removeAttribute(s) : typeof f != "string" && B(r).includes(s) ? r[s] = f : r.setAttribute(s, f));
}
function or(r, s, f, i, t = false) {
  var u = q(r), l = u[U], c = !u[V];
  let A = p && l;
  A && j(false);
  var o = s || {}, b = r.tagName === "OPTION";
  for (var n in s) n in f || (f[n] = null);
  f.class ? f.class = rr(f.class) : (i || f[N]) && (f.class = null), f[L] && (f.style ??= null);
  var g = B(r);
  for (const e in f) {
    let a = f[e];
    if (b && e === "value" && a == null) {
      r.value = r.__value = "", o[e] = a;
      continue;
    }
    if (e === "class") {
      var E = r.namespaceURI === "http://www.w3.org/1999/xhtml";
      sr(r, E, a, i, s?.[N], f[N]), o[e] = a, o[N] = f[N];
      continue;
    }
    if (e === "style") {
      tr(r, a, s?.[L], f[L]), o[e] = a, o[L] = f[L];
      continue;
    }
    var T = o[e];
    if (a !== T) {
      o[e] = a;
      var S = e[0] + e[1];
      if (S !== "$$") if (S === "on") {
        const d = {}, _ = "$$" + e;
        let v = e.slice(2);
        var I = m(v);
        if (J(v) && (v = v.slice(0, -7), d.capture = true), !I && T) {
          if (a != null) continue;
          r.removeEventListener(v, o[_], d), o[_] = null;
        }
        if (a != null) if (I) r[`__${v}`] = a, Q([v]);
        else {
          let H = function(K) {
            o[e].call(this, K);
          };
          o[_] = F(v, r, H, d);
        }
        else I && (r[`__${v}`] = void 0);
      } else if (e === "style") C(r, e, a);
      else if (e === "autofocus") W(r, !!a);
      else if (!l && (e === "__value" || e === "value" && a != null)) r.value = r.__value = a;
      else if (e === "selected" && b) ur(r, a);
      else {
        var h = e;
        c || (h = X(h));
        var $ = h === "defaultValue" || h === "defaultChecked";
        if (a == null && !l && !$) if (u[e] = null, h === "value" || h === "checked") {
          let d = r;
          const _ = s === void 0;
          if (h === "value") {
            let v = d.defaultValue;
            d.removeAttribute(h), d.defaultValue = v, d.value = d.__value = _ ? v : null;
          } else {
            let v = d.defaultChecked;
            d.removeAttribute(h), d.defaultChecked = v, d.checked = _ ? v : false;
          }
        } else r.removeAttribute(e);
        else $ || g.includes(h) && (l || typeof a != "string") ? r[h] = a : typeof a != "function" && C(r, h, a);
      }
    }
  }
  return A && j(true), o;
}
function q(r) {
  return r.__attributes ??= { [U]: r.nodeName.includes("-"), [V]: r.namespaceURI === Y };
}
var k = /* @__PURE__ */ new Map();
function B(r) {
  var s = k.get(r.nodeName);
  if (s) return s;
  k.set(r.nodeName, s = []);
  for (var f, i = r, t = Element.prototype; t !== i; ) {
    f = G(i);
    for (var u in f) f[u].set && s.push(u);
    i = y(i);
  }
  return s;
}
export {
  sr as a,
  or as b,
  rr as c,
  tr as d,
  x as e,
  lr as r,
  C as s
};
