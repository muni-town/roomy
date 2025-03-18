import { b as bo, a_ as mo, g as yo, N as vo, ad as So, a0 as ko, aN as Ao } from "./BMAj9zKA.js";
import { b as Oo, c as Co } from "./D7Oepc1u.js";
let Wi, xi, Mi, Di, Xi, Ni, Ui, Ji, Ki, Vi, zi, Bi, Fi, $i, Gs, Pi, Hi, qi, ji, Li, Eo;
let __tla = (async () => {
  Eo = function(t) {
    bo(t, t.v + 1);
  };
  Mi = function(t) {
    let e = 0, n = vo(0), r;
    return () => {
      mo() && (yo(n), So(() => (e === 0 && (r = ko(() => t(() => Eo(n)))), e += 1, () => {
        Ao().then(() => {
          e -= 1, e === 0 && (r?.(), r = void 0);
        });
      })));
    };
  };
  let It;
  const Mt = new Array(128).fill(void 0);
  Mt.push(void 0, null, true, false);
  Mt.length;
  const xe = typeof TextEncoder < "u" ? new TextEncoder("utf-8") : {
    encode: () => {
      throw Error("TextEncoder not available");
    }
  };
  xe.encodeInto;
  const Ro = typeof TextDecoder < "u" ? new TextDecoder("utf-8", {
    ignoreBOM: true,
    fatal: true
  }) : {
    decode: () => {
      throw Error("TextDecoder not available");
    }
  };
  typeof TextDecoder < "u" && Ro.decode();
  typeof FinalizationRegistry > "u" || new FinalizationRegistry((t) => It.__wbg_automerge_free(t >>> 0));
  typeof FinalizationRegistry > "u" || new FinalizationRegistry((t) => It.__wbg_syncstate_free(t >>> 0));
  let To = [];
  function Io(t) {
    for (const e in t) H[e] = t[e];
    for (const e of To) e();
  }
  const H = {
    create(t) {
      throw new RangeError("Automerge.use() not called");
    },
    load(t, e) {
      throw new RangeError("Automerge.use() not called (load)");
    },
    encodeChange(t) {
      throw new RangeError("Automerge.use() not called (encodeChange)");
    },
    decodeChange(t) {
      throw new RangeError("Automerge.use() not called (decodeChange)");
    },
    initSyncState() {
      throw new RangeError("Automerge.use() not called (initSyncState)");
    },
    encodeSyncMessage(t) {
      throw new RangeError("Automerge.use() not called (encodeSyncMessage)");
    },
    decodeSyncMessage(t) {
      throw new RangeError("Automerge.use() not called (decodeSyncMessage)");
    },
    encodeSyncState(t) {
      throw new RangeError("Automerge.use() not called (encodeSyncState)");
    },
    decodeSyncState(t) {
      throw new RangeError("Automerge.use() not called (decodeSyncState)");
    },
    exportSyncState(t) {
      throw new RangeError("Automerge.use() not called (exportSyncState)");
    },
    importSyncState(t) {
      throw new RangeError("Automerge.use() not called (importSyncState)");
    }
  }, Mo = "" + new URL("../assets/automerge_wasm_bg.BEjDkhWo.wasm", import.meta.url).href, xo = async (t = {}, e) => {
    let n;
    if (e.startsWith("data:")) {
      const r = e.replace(/^data:.*?base64,/, "");
      let o;
      if (typeof Buffer == "function" && typeof Buffer.from == "function") o = Buffer.from(r, "base64");
      else if (typeof atob == "function") {
        const a = atob(r);
        o = new Uint8Array(a.length);
        for (let _ = 0; _ < a.length; _++) o[_] = a.charCodeAt(_);
      } else throw new Error("Cannot decode base64-encoded data URL");
      n = await WebAssembly.instantiate(o, t);
    } else {
      const r = await fetch(e), o = r.headers.get("Content-Type") || "";
      if ("instantiateStreaming" in WebAssembly && o.startsWith("application/wasm")) n = await WebAssembly.instantiateStreaming(r, t);
      else {
        const a = await r.arrayBuffer();
        n = await WebAssembly.instantiate(a, t);
      }
    }
    return n.instance.exports;
  };
  let i;
  function xt(t) {
    i = t;
  }
  const N = new Array(128).fill(void 0);
  N.push(void 0, null, true, false);
  function p(t) {
    return N[t];
  }
  let re = N.length;
  function Po(t) {
    t < 132 || (N[t] = re, re = t);
  }
  function l(t) {
    const e = p(t);
    return Po(t), e;
  }
  let P = 0, ge = null;
  function we() {
    return (ge === null || ge.byteLength === 0) && (ge = new Uint8Array(i.memory.buffer)), ge;
  }
  const Do = typeof TextEncoder > "u" ? (0, module.require)("util").TextEncoder : TextEncoder;
  let be = new Do("utf-8");
  const Bo = typeof be.encodeInto == "function" ? function(t, e) {
    return be.encodeInto(t, e);
  } : function(t, e) {
    const n = be.encode(t);
    return e.set(n), {
      read: t.length,
      written: n.length
    };
  };
  function j(t, e, n) {
    if (n === void 0) {
      const s = be.encode(t), f = e(s.length, 1) >>> 0;
      return we().subarray(f, f + s.length).set(s), P = s.length, f;
    }
    let r = t.length, o = e(r, 1) >>> 0;
    const a = we();
    let _ = 0;
    for (; _ < r; _++) {
      const s = t.charCodeAt(_);
      if (s > 127) break;
      a[o + _] = s;
    }
    if (_ !== r) {
      _ !== 0 && (t = t.slice(_)), o = n(o, r, r = _ + t.length * 3, 1) >>> 0;
      const s = we().subarray(o + _, o + r), f = Bo(t, s);
      _ += f.written, o = n(o, r, _, 1) >>> 0;
    }
    return P = _, o;
  }
  function m(t) {
    return t == null;
  }
  let de = null;
  function c() {
    return (de === null || de.byteLength === 0) && (de = new Int32Array(i.memory.buffer)), de;
  }
  const jo = typeof TextDecoder > "u" ? (0, module.require)("util").TextDecoder : TextDecoder;
  let Pt = new jo("utf-8", {
    ignoreBOM: true,
    fatal: true
  });
  Pt.decode();
  function T(t, e) {
    return t = t >>> 0, Pt.decode(we().subarray(t, t + e));
  }
  function u(t) {
    re === N.length && N.push(N.length + 1);
    const e = re;
    return re = N[e], N[e] = t, e;
  }
  let pe = null;
  function me() {
    return (pe === null || pe.byteLength === 0) && (pe = new Float64Array(i.memory.buffer)), pe;
  }
  function je(t) {
    const e = typeof t;
    if (e == "number" || e == "boolean" || t == null) return `${t}`;
    if (e == "string") return `"${t}"`;
    if (e == "symbol") {
      const o = t.description;
      return o == null ? "Symbol" : `Symbol(${o})`;
    }
    if (e == "function") {
      const o = t.name;
      return typeof o == "string" && o.length > 0 ? `Function(${o})` : "Function";
    }
    if (Array.isArray(t)) {
      const o = t.length;
      let a = "[";
      o > 0 && (a += je(t[0]));
      for (let _ = 1; _ < o; _++) a += ", " + je(t[_]);
      return a += "]", a;
    }
    const n = /\[object ([^\]]+)\]/.exec(toString.call(t));
    let r;
    if (n.length > 1) r = n[1];
    else return toString.call(t);
    if (r == "Object") try {
      return "Object(" + JSON.stringify(t) + ")";
    } catch {
      return "Object";
    }
    return t instanceof Error ? `${t.name}: ${t.message}
${t.stack}` : r;
  }
  function q(t, e) {
    if (!(t instanceof e)) throw new Error(`expected instance of ${e.name}`);
    return t.ptr;
  }
  function $o(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.create(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return B.__wrap(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function Ho(t, e) {
    try {
      const a = i.__wbindgen_add_to_stack_pointer(-16);
      i.load(a, u(t), u(e));
      var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
      if (o) throw l(r);
      return B.__wrap(n);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function No(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.encodeChange(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return l(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function zo(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.decodeChange(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return l(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function Fo() {
    const t = i.initSyncState();
    return D.__wrap(t);
  }
  function Vo(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.importSyncState(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return D.__wrap(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function Lo(t) {
    q(t, D);
    const e = i.exportSyncState(t.__wbg_ptr);
    return l(e);
  }
  function Uo(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.encodeSyncMessage(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return l(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function Wo(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.decodeSyncMessage(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return l(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function qo(t) {
    q(t, D);
    const e = i.encodeSyncState(t.__wbg_ptr);
    return l(e);
  }
  function Jo(t) {
    try {
      const o = i.__wbindgen_add_to_stack_pointer(-16);
      i.decodeSyncState(o, u(t));
      var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
      if (r) throw l(n);
      return D.__wrap(e);
    } finally {
      i.__wbindgen_add_to_stack_pointer(16);
    }
  }
  function A(t, e) {
    try {
      return t.apply(this, e);
    } catch (n) {
      i.__wbindgen_exn_store(u(n));
    }
  }
  const Ko = Object.freeze({
    Array: 0,
    0: "Array",
    String: 1,
    1: "String"
  }), lt = typeof FinalizationRegistry > "u" ? {
    register: () => {
    },
    unregister: () => {
    }
  } : new FinalizationRegistry((t) => i.__wbg_automerge_free(t >>> 0));
  class B {
    static __wrap(e) {
      e = e >>> 0;
      const n = Object.create(B.prototype);
      return n.__wbg_ptr = e, lt.register(n, n.__wbg_ptr, n), n;
    }
    __destroy_into_raw() {
      const e = this.__wbg_ptr;
      return this.__wbg_ptr = 0, lt.unregister(this), e;
    }
    free() {
      const e = this.__destroy_into_raw();
      i.__wbg_automerge_free(e);
    }
    static new(e, n) {
      try {
        const f = i.__wbindgen_add_to_stack_pointer(-16);
        var r = m(e) ? 0 : j(e, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
        i.automerge_new(f, r, o, n);
        var a = c()[f / 4 + 0], _ = c()[f / 4 + 1], s = c()[f / 4 + 2];
        if (s) throw l(_);
        return B.__wrap(a);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    clone(e) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        var n = m(e) ? 0 : j(e, i.__wbindgen_malloc, i.__wbindgen_realloc), r = P;
        i.automerge_clone(s, this.__wbg_ptr, n, r);
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return B.__wrap(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    fork(e, n) {
      try {
        const f = i.__wbindgen_add_to_stack_pointer(-16);
        var r = m(e) ? 0 : j(e, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
        i.automerge_fork(f, this.__wbg_ptr, r, o, u(n));
        var a = c()[f / 4 + 0], _ = c()[f / 4 + 1], s = c()[f / 4 + 2];
        if (s) throw l(_);
        return B.__wrap(a);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    pendingOps() {
      const e = i.automerge_pendingOps(this.__wbg_ptr);
      return l(e);
    }
    commit(e, n) {
      var r = m(e) ? 0 : j(e, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
      const a = i.automerge_commit(this.__wbg_ptr, r, o, !m(n), m(n) ? 0 : n);
      return l(a);
    }
    merge(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        q(e, B), i.automerge_merge(a, this.__wbg_ptr, e.__wbg_ptr);
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    rollback() {
      return i.automerge_rollback(this.__wbg_ptr);
    }
    keys(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_keys(_, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    text(e, n) {
      let r, o;
      try {
        const h = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_text(h, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var a = c()[h / 4 + 0], _ = c()[h / 4 + 1], s = c()[h / 4 + 2], f = c()[h / 4 + 3], g = a, w = _;
        if (f) throw g = 0, w = 0, l(s);
        return r = g, o = w, T(g, w);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16), i.__wbindgen_free(r, o, 1);
      }
    }
    spans(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_spans(_, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    splice(e, n, r, o) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_splice(s, this.__wbg_ptr, u(e), n, r, u(o));
        var a = c()[s / 4 + 0], _ = c()[s / 4 + 1];
        if (_) throw l(a);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    updateText(e, n) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_updateText(a, this.__wbg_ptr, u(e), u(n));
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        if (o) throw l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    updateSpans(e, n) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_updateSpans(a, this.__wbg_ptr, u(e), u(n));
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        if (o) throw l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    push(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_push(_, this.__wbg_ptr, u(e), u(n), u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    pushObject(e, n) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_pushObject(s, this.__wbg_ptr, u(e), u(n));
        var r = c()[s / 4 + 0], o = c()[s / 4 + 1], a = c()[s / 4 + 2], _ = c()[s / 4 + 3];
        if (_) throw l(a);
        let f;
        return r !== 0 && (f = T(r, o).slice(), i.__wbindgen_free(r, o * 1, 1)), f;
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    insert(e, n, r, o) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_insert(s, this.__wbg_ptr, u(e), n, u(r), u(o));
        var a = c()[s / 4 + 0], _ = c()[s / 4 + 1];
        if (_) throw l(a);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    splitBlock(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_splitBlock(_, this.__wbg_ptr, u(e), n, u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    joinBlock(e, n) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_joinBlock(a, this.__wbg_ptr, u(e), n);
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        if (o) throw l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    updateBlock(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_updateBlock(_, this.__wbg_ptr, u(e), n, u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getBlock(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getBlock(s, this.__wbg_ptr, u(e), n, m(r) ? 0 : u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    insertObject(e, n, r) {
      try {
        const f = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_insertObject(f, this.__wbg_ptr, u(e), n, u(r));
        var o = c()[f / 4 + 0], a = c()[f / 4 + 1], _ = c()[f / 4 + 2], s = c()[f / 4 + 3];
        if (s) throw l(_);
        let g;
        return o !== 0 && (g = T(o, a).slice(), i.__wbindgen_free(o, a * 1, 1)), g;
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    put(e, n, r, o) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_put(s, this.__wbg_ptr, u(e), u(n), u(r), u(o));
        var a = c()[s / 4 + 0], _ = c()[s / 4 + 1];
        if (_) throw l(a);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    putObject(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_putObject(s, this.__wbg_ptr, u(e), u(n), u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    increment(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_increment(_, this.__wbg_ptr, u(e), u(n), u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    get(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_get(s, this.__wbg_ptr, u(e), u(n), m(r) ? 0 : u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getWithType(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getWithType(s, this.__wbg_ptr, u(e), u(n), m(r) ? 0 : u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    objInfo(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_objInfo(_, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getAll(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getAll(s, this.__wbg_ptr, u(e), u(n), m(r) ? 0 : u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    enableFreeze(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_enableFreeze(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    registerDatatype(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_registerDatatype(_, this.__wbg_ptr, u(e), u(n), u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    applyPatches(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_applyPatches(_, this.__wbg_ptr, u(e), u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    applyAndReturnPatches(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_applyAndReturnPatches(_, this.__wbg_ptr, u(e), u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    diffIncremental() {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_diffIncremental(o, this.__wbg_ptr);
        var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
        if (r) throw l(n);
        return l(e);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    updateDiffCursor() {
      i.automerge_updateDiffCursor(this.__wbg_ptr);
    }
    resetDiffCursor() {
      i.automerge_resetDiffCursor(this.__wbg_ptr);
    }
    diff(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_diff(_, this.__wbg_ptr, u(e), u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    isolate(e) {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_isolate(o, this.__wbg_ptr, u(e));
        var n = c()[o / 4 + 0], r = c()[o / 4 + 1];
        if (r) throw l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    integrate() {
      i.automerge_integrate(this.__wbg_ptr);
    }
    length(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_length(_, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var r = me()[_ / 8 + 0], o = c()[_ / 4 + 2], a = c()[_ / 4 + 3];
        if (a) throw l(o);
        return r;
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    delete(e, n) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_delete(a, this.__wbg_ptr, u(e), u(n));
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        if (o) throw l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    save() {
      const e = i.automerge_save(this.__wbg_ptr);
      return l(e);
    }
    saveIncremental() {
      const e = i.automerge_saveIncremental(this.__wbg_ptr);
      return l(e);
    }
    saveSince(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_saveSince(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    saveNoCompress() {
      const e = i.automerge_saveNoCompress(this.__wbg_ptr);
      return l(e);
    }
    saveAndVerify() {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_saveAndVerify(o, this.__wbg_ptr);
        var e = c()[o / 4 + 0], n = c()[o / 4 + 1], r = c()[o / 4 + 2];
        if (r) throw l(n);
        return l(e);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    loadIncremental(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_loadIncremental(a, this.__wbg_ptr, u(e));
        var n = me()[a / 8 + 0], r = c()[a / 4 + 2], o = c()[a / 4 + 3];
        if (o) throw l(r);
        return n;
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    applyChanges(e) {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_applyChanges(o, this.__wbg_ptr, u(e));
        var n = c()[o / 4 + 0], r = c()[o / 4 + 1];
        if (r) throw l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getChanges(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getChanges(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getChangeByHash(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getChangeByHash(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getDecodedChangeByHash(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getDecodedChangeByHash(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getChangesAdded(e) {
      q(e, B);
      const n = i.automerge_getChangesAdded(this.__wbg_ptr, e.__wbg_ptr);
      return l(n);
    }
    getHeads() {
      const e = i.automerge_getHeads(this.__wbg_ptr);
      return l(e);
    }
    getActorId() {
      let e, n;
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getActorId(a, this.__wbg_ptr);
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        return e = r, n = o, T(r, o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16), i.__wbindgen_free(e, n, 1);
      }
    }
    getLastLocalChange() {
      const e = i.automerge_getLastLocalChange(this.__wbg_ptr);
      return l(e);
    }
    dump() {
      i.automerge_dump(this.__wbg_ptr);
    }
    getMissingDeps(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getMissingDeps(a, this.__wbg_ptr, m(e) ? 0 : u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    receiveSyncMessage(e, n) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        q(e, D), i.automerge_receiveSyncMessage(a, this.__wbg_ptr, e.__wbg_ptr, u(n));
        var r = c()[a / 4 + 0], o = c()[a / 4 + 1];
        if (o) throw l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    generateSyncMessage(e) {
      q(e, D);
      const n = i.automerge_generateSyncMessage(this.__wbg_ptr, e.__wbg_ptr);
      return l(n);
    }
    toJS(e) {
      try {
        const a = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_toJS(a, this.__wbg_ptr, u(e));
        var n = c()[a / 4 + 0], r = c()[a / 4 + 1], o = c()[a / 4 + 2];
        if (o) throw l(r);
        return l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    materialize(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_materialize(s, this.__wbg_ptr, u(e), m(n) ? 0 : u(n), u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    getCursor(e, n, r) {
      let o, a;
      try {
        const y = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getCursor(y, this.__wbg_ptr, u(e), n, m(r) ? 0 : u(r));
        var _ = c()[y / 4 + 0], s = c()[y / 4 + 1], f = c()[y / 4 + 2], g = c()[y / 4 + 3], w = _, h = s;
        if (g) throw w = 0, h = 0, l(f);
        return o = w, a = h, T(w, h);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16), i.__wbindgen_free(o, a, 1);
      }
    }
    getCursorPosition(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_getCursorPosition(s, this.__wbg_ptr, u(e), u(n), m(r) ? 0 : u(r));
        var o = me()[s / 8 + 0], a = c()[s / 4 + 2], _ = c()[s / 4 + 3];
        if (_) throw l(a);
        return o;
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    emptyChange(e, n) {
      var r = m(e) ? 0 : j(e, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
      const a = i.automerge_emptyChange(this.__wbg_ptr, r, o, !m(n), m(n) ? 0 : n);
      return l(a);
    }
    mark(e, n, r, o, a) {
      try {
        const f = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_mark(f, this.__wbg_ptr, u(e), u(n), u(r), u(o), u(a));
        var _ = c()[f / 4 + 0], s = c()[f / 4 + 1];
        if (s) throw l(_);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    unmark(e, n, r) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_unmark(_, this.__wbg_ptr, u(e), u(n), u(r));
        var o = c()[_ / 4 + 0], a = c()[_ / 4 + 1];
        if (a) throw l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    marks(e, n) {
      try {
        const _ = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_marks(_, this.__wbg_ptr, u(e), m(n) ? 0 : u(n));
        var r = c()[_ / 4 + 0], o = c()[_ / 4 + 1], a = c()[_ / 4 + 2];
        if (a) throw l(o);
        return l(r);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    marksAt(e, n, r) {
      try {
        const s = i.__wbindgen_add_to_stack_pointer(-16);
        i.automerge_marksAt(s, this.__wbg_ptr, u(e), n, m(r) ? 0 : u(r));
        var o = c()[s / 4 + 0], a = c()[s / 4 + 1], _ = c()[s / 4 + 2];
        if (_) throw l(a);
        return l(o);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    hasOurChanges(e) {
      q(e, D);
      const n = i.automerge_hasOurChanges(this.__wbg_ptr, e.__wbg_ptr);
      return l(n);
    }
    topoHistoryTraversal() {
      const e = i.automerge_topoHistoryTraversal(this.__wbg_ptr);
      return l(e);
    }
    stats() {
      const e = i.automerge_stats(this.__wbg_ptr);
      return l(e);
    }
  }
  const gt = typeof FinalizationRegistry > "u" ? {
    register: () => {
    },
    unregister: () => {
    }
  } : new FinalizationRegistry((t) => i.__wbg_syncstate_free(t >>> 0));
  class D {
    static __wrap(e) {
      e = e >>> 0;
      const n = Object.create(D.prototype);
      return n.__wbg_ptr = e, gt.register(n, n.__wbg_ptr, n), n;
    }
    __destroy_into_raw() {
      const e = this.__wbg_ptr;
      return this.__wbg_ptr = 0, gt.unregister(this), e;
    }
    free() {
      const e = this.__destroy_into_raw();
      i.__wbg_syncstate_free(e);
    }
    get sharedHeads() {
      const e = i.syncstate_sharedHeads(this.__wbg_ptr);
      return l(e);
    }
    get lastSentHeads() {
      const e = i.syncstate_lastSentHeads(this.__wbg_ptr);
      return l(e);
    }
    set lastSentHeads(e) {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.syncstate_set_lastSentHeads(o, this.__wbg_ptr, u(e));
        var n = c()[o / 4 + 0], r = c()[o / 4 + 1];
        if (r) throw l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    set sentHashes(e) {
      try {
        const o = i.__wbindgen_add_to_stack_pointer(-16);
        i.syncstate_set_sentHashes(o, this.__wbg_ptr, u(e));
        var n = c()[o / 4 + 0], r = c()[o / 4 + 1];
        if (r) throw l(n);
      } finally {
        i.__wbindgen_add_to_stack_pointer(16);
      }
    }
    clone() {
      const e = i.syncstate_clone(this.__wbg_ptr);
      return D.__wrap(e);
    }
  }
  function Dt(t) {
    l(t);
  }
  function Bt(t, e) {
    const n = p(e), r = typeof n == "string" ? n : void 0;
    var o = m(r) ? 0 : j(r, i.__wbindgen_malloc, i.__wbindgen_realloc), a = P;
    c()[t / 4 + 1] = a, c()[t / 4 + 0] = o;
  }
  function jt(t, e) {
    const n = new Error(T(t, e));
    return u(n);
  }
  function $t(t, e) {
    const n = T(t, e);
    return u(n);
  }
  function Ht(t) {
    return u(t);
  }
  function Nt(t) {
    const e = p(t);
    return u(e);
  }
  function zt(t, e) {
    const n = p(e), r = typeof n == "number" ? n : void 0;
    me()[t / 8 + 1] = m(r) ? 0 : r, c()[t / 4 + 0] = !m(r);
  }
  function Ft(t) {
    return p(t) === void 0;
  }
  function Vt(t) {
    const e = p(t);
    return typeof e == "boolean" ? e ? 1 : 0 : 2;
  }
  function Lt(t) {
    return p(t) === null;
  }
  function Ut(t) {
    return typeof p(t) == "string";
  }
  function Wt(t) {
    return typeof p(t) == "function";
  }
  function qt(t) {
    const e = p(t);
    return typeof e == "object" && e !== null;
  }
  function Jt(t) {
    return Array.isArray(p(t));
  }
  function Kt(t, e) {
    const n = p(e), r = JSON.stringify(n === void 0 ? null : n), o = j(r, i.__wbindgen_malloc, i.__wbindgen_realloc), a = P;
    c()[t / 4 + 1] = a, c()[t / 4 + 0] = o;
  }
  function Xt() {
    const t = new Error();
    return u(t);
  }
  function Yt(t, e) {
    const n = p(e).stack, r = j(n, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
    c()[t / 4 + 1] = o, c()[t / 4 + 0] = r;
  }
  function Gt(t, e) {
    let n, r;
    try {
      n = t, r = e, console.error(T(t, e));
    } finally {
      i.__wbindgen_free(n, r, 1);
    }
  }
  function Qt(t, e) {
    return p(t) == p(e);
  }
  function Zt(t, e) {
    const n = String(p(e)), r = j(n, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
    c()[t / 4 + 1] = o, c()[t / 4 + 0] = r;
  }
  function en(t) {
    return u(t);
  }
  function tn(t) {
    const e = BigInt.asUintN(64, t);
    return u(e);
  }
  function nn(t, e, n) {
    p(t)[l(e)] = l(n);
  }
  function rn() {
    return A(function(t, e) {
      p(t).getRandomValues(p(e));
    }, arguments);
  }
  function on() {
    return A(function(t, e) {
      p(t).randomFillSync(l(e));
    }, arguments);
  }
  function an(t) {
    const e = p(t).crypto;
    return u(e);
  }
  function _n(t) {
    const e = p(t).process;
    return u(e);
  }
  function sn(t) {
    const e = p(t).versions;
    return u(e);
  }
  function cn(t) {
    const e = p(t).node;
    return u(e);
  }
  function un() {
    return A(function() {
      const t = module.require;
      return u(t);
    }, arguments);
  }
  function fn(t) {
    const e = p(t).msCrypto;
    return u(e);
  }
  function ln(t) {
    console.log(p(t));
  }
  function gn(t, e) {
    console.log(p(t), p(e));
  }
  function dn(t, e) {
    const n = p(t)[e >>> 0];
    return u(n);
  }
  function pn(t) {
    return p(t).length;
  }
  function hn() {
    const t = new Array();
    return u(t);
  }
  function wn(t, e) {
    const n = new Function(T(t, e));
    return u(n);
  }
  function bn(t) {
    const e = p(t).next;
    return u(e);
  }
  function mn() {
    return A(function(t) {
      const e = p(t).next();
      return u(e);
    }, arguments);
  }
  function yn(t) {
    return p(t).done;
  }
  function vn(t) {
    const e = p(t).value;
    return u(e);
  }
  function Sn() {
    return u(Symbol.iterator);
  }
  function kn() {
    return A(function(t, e) {
      const n = Reflect.get(p(t), p(e));
      return u(n);
    }, arguments);
  }
  function An() {
    return A(function(t, e) {
      const n = p(t).call(p(e));
      return u(n);
    }, arguments);
  }
  function On() {
    const t = new Object();
    return u(t);
  }
  function Cn(t) {
    return p(t).length;
  }
  function En(t, e, n) {
    p(t)[e >>> 0] = l(n);
  }
  function Rn(t) {
    const e = Array.from(p(t));
    return u(e);
  }
  function Tn(t) {
    return Array.isArray(p(t));
  }
  function In(t, e) {
    return p(t).push(p(e));
  }
  function Mn(t, e) {
    return p(t).unshift(p(e));
  }
  function xn(t) {
    let e;
    try {
      e = p(t) instanceof ArrayBuffer;
    } catch {
      e = false;
    }
    return e;
  }
  function Pn(t, e) {
    const n = new Error(T(t, e));
    return u(n);
  }
  function Dn() {
    return A(function(t, e, n) {
      const r = p(t).call(p(e), p(n));
      return u(r);
    }, arguments);
  }
  function Bn(t) {
    let e;
    try {
      e = p(t) instanceof Date;
    } catch {
      e = false;
    }
    return e;
  }
  function jn(t) {
    return p(t).getTime();
  }
  function $n(t) {
    const e = new Date(p(t));
    return u(e);
  }
  function Hn(t) {
    let e;
    try {
      e = p(t) instanceof Object;
    } catch {
      e = false;
    }
    return e;
  }
  function Nn(t, e) {
    const n = Object.assign(p(t), p(e));
    return u(n);
  }
  function zn(t, e, n) {
    const r = Object.defineProperty(p(t), p(e), p(n));
    return u(r);
  }
  function Fn(t) {
    const e = Object.entries(p(t));
    return u(e);
  }
  function Vn(t) {
    const e = Object.freeze(p(t));
    return u(e);
  }
  function Ln(t) {
    const e = Object.keys(p(t));
    return u(e);
  }
  function Un(t) {
    const e = Object.values(p(t));
    return u(e);
  }
  function Wn(t, e) {
    const n = new RangeError(T(t, e));
    return u(n);
  }
  function qn() {
    return A(function(t, e, n) {
      const r = Reflect.apply(p(t), p(e), p(n));
      return u(r);
    }, arguments);
  }
  function Jn() {
    return A(function(t, e) {
      return Reflect.deleteProperty(p(t), p(e));
    }, arguments);
  }
  function Kn() {
    return A(function(t) {
      const e = Reflect.ownKeys(p(t));
      return u(e);
    }, arguments);
  }
  function Xn() {
    return A(function(t, e, n) {
      return Reflect.set(p(t), p(e), p(n));
    }, arguments);
  }
  function Yn(t) {
    const e = p(t).buffer;
    return u(e);
  }
  function Gn(t, e) {
    const n = p(t).concat(p(e));
    return u(n);
  }
  function Qn(t, e, n) {
    const r = p(t).slice(e >>> 0, n >>> 0);
    return u(r);
  }
  function Zn(t, e) {
    const n = Symbol.for(T(t, e));
    return u(n);
  }
  function er(t) {
    const e = p(t).toString();
    return u(e);
  }
  function tr() {
    return A(function() {
      const t = self.self;
      return u(t);
    }, arguments);
  }
  function nr() {
    return A(function() {
      const t = window.window;
      return u(t);
    }, arguments);
  }
  function rr() {
    return A(function() {
      const t = globalThis.globalThis;
      return u(t);
    }, arguments);
  }
  function or() {
    return A(function() {
      const t = global.global;
      return u(t);
    }, arguments);
  }
  function ar(t, e, n) {
    const r = new Uint8Array(p(t), e >>> 0, n >>> 0);
    return u(r);
  }
  function _r(t) {
    const e = new Uint8Array(p(t));
    return u(e);
  }
  function sr(t, e, n) {
    p(t).set(p(e), n >>> 0);
  }
  function ir(t) {
    return p(t).length;
  }
  function cr(t) {
    let e;
    try {
      e = p(t) instanceof Uint8Array;
    } catch {
      e = false;
    }
    return e;
  }
  function ur(t) {
    const e = new Uint8Array(t >>> 0);
    return u(e);
  }
  function fr(t, e, n) {
    const r = p(t).subarray(e >>> 0, n >>> 0);
    return u(r);
  }
  function lr(t, e) {
    const n = je(p(e)), r = j(n, i.__wbindgen_malloc, i.__wbindgen_realloc), o = P;
    c()[t / 4 + 1] = o, c()[t / 4 + 0] = r;
  }
  function gr(t, e) {
    throw new Error(T(t, e));
  }
  function dr() {
    const t = i.memory;
    return u(t);
  }
  URL = globalThis.URL;
  const d = await xo({
    "./automerge_wasm_bg.js": {
      __wbindgen_object_drop_ref: Dt,
      __wbindgen_string_get: Bt,
      __wbindgen_error_new: jt,
      __wbindgen_string_new: $t,
      __wbindgen_number_new: Ht,
      __wbindgen_object_clone_ref: Nt,
      __wbindgen_number_get: zt,
      __wbindgen_is_undefined: Ft,
      __wbindgen_boolean_get: Vt,
      __wbindgen_is_null: Lt,
      __wbindgen_is_string: Ut,
      __wbindgen_is_function: Wt,
      __wbindgen_is_object: qt,
      __wbindgen_is_array: Jt,
      __wbindgen_json_serialize: Kt,
      __wbg_new_abda76e883ba8a5f: Xt,
      __wbg_stack_658279fe44541cf6: Yt,
      __wbg_error_f851667af71bcfc6: Gt,
      __wbindgen_jsval_loose_eq: Qt,
      __wbg_String_91fba7ded13ba54c: Zt,
      __wbindgen_bigint_from_i64: en,
      __wbindgen_bigint_from_u64: tn,
      __wbg_set_20cbc34131e76824: nn,
      __wbg_getRandomValues_3aa56aa6edec874c: rn,
      __wbg_randomFillSync_5c9c955aa56b6049: on,
      __wbg_crypto_1d1f22824a6a080c: an,
      __wbg_process_4a72847cc503995b: _n,
      __wbg_versions_f686565e586dd935: sn,
      __wbg_node_104a2ff8d6ea03a2: cn,
      __wbg_require_cca90b1a94a0255b: un,
      __wbg_msCrypto_eb05e62b530a1508: fn,
      __wbg_log_5bb5f88f245d7762: ln,
      __wbg_log_1746d5c75ec89963: gn,
      __wbg_get_bd8e338fbd5f5cc8: dn,
      __wbg_length_cd7af8117672b8b8: pn,
      __wbg_new_16b304a2cfa7ff4a: hn,
      __wbg_newnoargs_e258087cd0daa0ea: wn,
      __wbg_next_40fc327bfc8770e6: bn,
      __wbg_next_196c84450b364254: mn,
      __wbg_done_298b57d23c0fc80c: yn,
      __wbg_value_d93c65011f51a456: vn,
      __wbg_iterator_2cee6dadfd956dfa: Sn,
      __wbg_get_e3c254076557e348: kn,
      __wbg_call_27c0f87801dedf93: An,
      __wbg_new_72fb9a18b5ae2624: On,
      __wbg_length_dee433d4c85c9387: Cn,
      __wbg_set_d4638f722068f043: En,
      __wbg_from_89e3fc3ba5e6fb48: Rn,
      __wbg_isArray_2ab64d95e09ea0ae: Tn,
      __wbg_push_a5b05aedc7234f9f: In,
      __wbg_unshift_e22df4b34bcf5070: Mn,
      __wbg_instanceof_ArrayBuffer_836825be07d4c9d2: xn,
      __wbg_new_28c511d9baebfa89: Pn,
      __wbg_call_b3ca7c6051f9bec1: Dn,
      __wbg_instanceof_Date_f65cf97fb83fc369: Bn,
      __wbg_getTime_2bc4375165f02d15: jn,
      __wbg_new_cf3ec55744a78578: $n,
      __wbg_instanceof_Object_71ca3c0a59266746: Hn,
      __wbg_assign_496d2d14fecafbcf: Nn,
      __wbg_defineProperty_cc00e2de8a0f5141: zn,
      __wbg_entries_95cc2c823b285a09: Fn,
      __wbg_freeze_cc6bc19f75299986: Vn,
      __wbg_keys_91e412b4b222659f: Ln,
      __wbg_values_9c75e6e2bfbdb70d: Un,
      __wbg_new_dd6a5dd7b538af21: Wn,
      __wbg_apply_0a5aa603881e6d79: qn,
      __wbg_deleteProperty_13e721a56f19e842: Jn,
      __wbg_ownKeys_658942b7f28d1fe9: Kn,
      __wbg_set_1f9b04f170055d33: Xn,
      __wbg_buffer_12d079cc21e14bdb: Yn,
      __wbg_concat_3de229fe4fe90fea: Gn,
      __wbg_slice_52fb626ffdc8da8f: Qn,
      __wbg_for_27c67e2dbdce22f6: Zn,
      __wbg_toString_7df3c77999517c20: er,
      __wbg_self_ce0dbfc45cf2f5be: tr,
      __wbg_window_c6fb939a7f436783: nr,
      __wbg_globalThis_d1e6af4856ba331b: rr,
      __wbg_global_207b558942527489: or,
      __wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb: ar,
      __wbg_new_63b92bc8671ed464: _r,
      __wbg_set_a47bac70306a19a7: sr,
      __wbg_length_c20a40f15020d68a: ir,
      __wbg_instanceof_Uint8Array_2b3bbecd033d19f6: cr,
      __wbg_newwithlength_e9b4878cebadb3d3: ur,
      __wbg_subarray_a1f73cd4b5b42fe1: fr,
      __wbindgen_debug_string: lr,
      __wbindgen_throw: gr,
      __wbindgen_memory: dr
    }
  }, Mo), Xo = d.memory, Yo = d.__wbg_syncstate_free, Go = d.syncstate_sharedHeads, Qo = d.syncstate_lastSentHeads, Zo = d.syncstate_set_lastSentHeads, ea = d.syncstate_set_sentHashes, ta = d.syncstate_clone, na = d.__wbg_automerge_free, ra = d.automerge_new, oa = d.automerge_clone, aa = d.automerge_fork, _a = d.automerge_pendingOps, sa = d.automerge_commit, ia = d.automerge_merge, ca = d.automerge_rollback, ua = d.automerge_keys, fa = d.automerge_text, la = d.automerge_spans, ga = d.automerge_splice, da = d.automerge_updateText, pa = d.automerge_updateSpans, ha = d.automerge_push, wa = d.automerge_pushObject, ba = d.automerge_insert, ma = d.automerge_splitBlock, ya = d.automerge_joinBlock, va = d.automerge_updateBlock, Sa = d.automerge_getBlock, ka = d.automerge_insertObject, Aa = d.automerge_put, Oa = d.automerge_putObject, Ca = d.automerge_increment, Ea = d.automerge_get, Ra = d.automerge_getWithType, Ta = d.automerge_objInfo, Ia = d.automerge_getAll, Ma = d.automerge_enableFreeze, xa = d.automerge_registerDatatype, Pa = d.automerge_applyPatches, Da = d.automerge_applyAndReturnPatches, Ba = d.automerge_diffIncremental, ja = d.automerge_updateDiffCursor, $a = d.automerge_resetDiffCursor, Ha = d.automerge_diff, Na = d.automerge_isolate, za = d.automerge_integrate, Fa = d.automerge_length, Va = d.automerge_delete, La = d.automerge_save, Ua = d.automerge_saveIncremental, Wa = d.automerge_saveSince, qa = d.automerge_saveNoCompress, Ja = d.automerge_saveAndVerify, Ka = d.automerge_loadIncremental, Xa = d.automerge_applyChanges, Ya = d.automerge_getChanges, Ga = d.automerge_getChangeByHash, Qa = d.automerge_getDecodedChangeByHash, Za = d.automerge_getChangesAdded, e_ = d.automerge_getHeads, t_ = d.automerge_getActorId, n_ = d.automerge_getLastLocalChange, r_ = d.automerge_dump, o_ = d.automerge_getMissingDeps, a_ = d.automerge_receiveSyncMessage, __ = d.automerge_generateSyncMessage, s_ = d.automerge_toJS, i_ = d.automerge_materialize, c_ = d.automerge_getCursor, u_ = d.automerge_getCursorPosition, f_ = d.automerge_emptyChange, l_ = d.automerge_mark, g_ = d.automerge_unmark, d_ = d.automerge_marks, p_ = d.automerge_marksAt, h_ = d.automerge_hasOurChanges, w_ = d.automerge_topoHistoryTraversal, b_ = d.automerge_stats, m_ = d.create, y_ = d.load, v_ = d.encodeChange, S_ = d.decodeChange, k_ = d.initSyncState, A_ = d.importSyncState, O_ = d.exportSyncState, C_ = d.encodeSyncMessage, E_ = d.decodeSyncMessage, R_ = d.encodeSyncState, T_ = d.decodeSyncState, I_ = d.__wbindgen_malloc, M_ = d.__wbindgen_realloc, x_ = d.__wbindgen_add_to_stack_pointer, P_ = d.__wbindgen_free, D_ = d.__wbindgen_exn_store, B_ = Object.freeze(Object.defineProperty({
    __proto__: null,
    __wbg_automerge_free: na,
    __wbg_syncstate_free: Yo,
    __wbindgen_add_to_stack_pointer: x_,
    __wbindgen_exn_store: D_,
    __wbindgen_free: P_,
    __wbindgen_malloc: I_,
    __wbindgen_realloc: M_,
    automerge_applyAndReturnPatches: Da,
    automerge_applyChanges: Xa,
    automerge_applyPatches: Pa,
    automerge_clone: oa,
    automerge_commit: sa,
    automerge_delete: Va,
    automerge_diff: Ha,
    automerge_diffIncremental: Ba,
    automerge_dump: r_,
    automerge_emptyChange: f_,
    automerge_enableFreeze: Ma,
    automerge_fork: aa,
    automerge_generateSyncMessage: __,
    automerge_get: Ea,
    automerge_getActorId: t_,
    automerge_getAll: Ia,
    automerge_getBlock: Sa,
    automerge_getChangeByHash: Ga,
    automerge_getChanges: Ya,
    automerge_getChangesAdded: Za,
    automerge_getCursor: c_,
    automerge_getCursorPosition: u_,
    automerge_getDecodedChangeByHash: Qa,
    automerge_getHeads: e_,
    automerge_getLastLocalChange: n_,
    automerge_getMissingDeps: o_,
    automerge_getWithType: Ra,
    automerge_hasOurChanges: h_,
    automerge_increment: Ca,
    automerge_insert: ba,
    automerge_insertObject: ka,
    automerge_integrate: za,
    automerge_isolate: Na,
    automerge_joinBlock: ya,
    automerge_keys: ua,
    automerge_length: Fa,
    automerge_loadIncremental: Ka,
    automerge_mark: l_,
    automerge_marks: d_,
    automerge_marksAt: p_,
    automerge_materialize: i_,
    automerge_merge: ia,
    automerge_new: ra,
    automerge_objInfo: Ta,
    automerge_pendingOps: _a,
    automerge_push: ha,
    automerge_pushObject: wa,
    automerge_put: Aa,
    automerge_putObject: Oa,
    automerge_receiveSyncMessage: a_,
    automerge_registerDatatype: xa,
    automerge_resetDiffCursor: $a,
    automerge_rollback: ca,
    automerge_save: La,
    automerge_saveAndVerify: Ja,
    automerge_saveIncremental: Ua,
    automerge_saveNoCompress: qa,
    automerge_saveSince: Wa,
    automerge_spans: la,
    automerge_splice: ga,
    automerge_splitBlock: ma,
    automerge_stats: b_,
    automerge_text: fa,
    automerge_toJS: s_,
    automerge_topoHistoryTraversal: w_,
    automerge_unmark: g_,
    automerge_updateBlock: va,
    automerge_updateDiffCursor: ja,
    automerge_updateSpans: pa,
    automerge_updateText: da,
    create: m_,
    decodeChange: S_,
    decodeSyncMessage: E_,
    decodeSyncState: T_,
    encodeChange: v_,
    encodeSyncMessage: C_,
    encodeSyncState: R_,
    exportSyncState: O_,
    importSyncState: A_,
    initSyncState: k_,
    load: y_,
    memory: Xo,
    syncstate_clone: ta,
    syncstate_lastSentHeads: Qo,
    syncstate_set_lastSentHeads: Zo,
    syncstate_set_sentHashes: ea,
    syncstate_sharedHeads: Go
  }, Symbol.toStringTag, {
    value: "Module"
  }));
  xt(B_);
  const j_ = Object.freeze(Object.defineProperty({
    __proto__: null,
    Automerge: B,
    SyncState: D,
    TextRepresentation: Ko,
    __wbg_String_91fba7ded13ba54c: Zt,
    __wbg_apply_0a5aa603881e6d79: qn,
    __wbg_assign_496d2d14fecafbcf: Nn,
    __wbg_buffer_12d079cc21e14bdb: Yn,
    __wbg_call_27c0f87801dedf93: An,
    __wbg_call_b3ca7c6051f9bec1: Dn,
    __wbg_concat_3de229fe4fe90fea: Gn,
    __wbg_crypto_1d1f22824a6a080c: an,
    __wbg_defineProperty_cc00e2de8a0f5141: zn,
    __wbg_deleteProperty_13e721a56f19e842: Jn,
    __wbg_done_298b57d23c0fc80c: yn,
    __wbg_entries_95cc2c823b285a09: Fn,
    __wbg_error_f851667af71bcfc6: Gt,
    __wbg_for_27c67e2dbdce22f6: Zn,
    __wbg_freeze_cc6bc19f75299986: Vn,
    __wbg_from_89e3fc3ba5e6fb48: Rn,
    __wbg_getRandomValues_3aa56aa6edec874c: rn,
    __wbg_getTime_2bc4375165f02d15: jn,
    __wbg_get_bd8e338fbd5f5cc8: dn,
    __wbg_get_e3c254076557e348: kn,
    __wbg_globalThis_d1e6af4856ba331b: rr,
    __wbg_global_207b558942527489: or,
    __wbg_instanceof_ArrayBuffer_836825be07d4c9d2: xn,
    __wbg_instanceof_Date_f65cf97fb83fc369: Bn,
    __wbg_instanceof_Object_71ca3c0a59266746: Hn,
    __wbg_instanceof_Uint8Array_2b3bbecd033d19f6: cr,
    __wbg_isArray_2ab64d95e09ea0ae: Tn,
    __wbg_iterator_2cee6dadfd956dfa: Sn,
    __wbg_keys_91e412b4b222659f: Ln,
    __wbg_length_c20a40f15020d68a: ir,
    __wbg_length_cd7af8117672b8b8: pn,
    __wbg_length_dee433d4c85c9387: Cn,
    __wbg_log_1746d5c75ec89963: gn,
    __wbg_log_5bb5f88f245d7762: ln,
    __wbg_msCrypto_eb05e62b530a1508: fn,
    __wbg_new_16b304a2cfa7ff4a: hn,
    __wbg_new_28c511d9baebfa89: Pn,
    __wbg_new_63b92bc8671ed464: _r,
    __wbg_new_72fb9a18b5ae2624: On,
    __wbg_new_abda76e883ba8a5f: Xt,
    __wbg_new_cf3ec55744a78578: $n,
    __wbg_new_dd6a5dd7b538af21: Wn,
    __wbg_newnoargs_e258087cd0daa0ea: wn,
    __wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb: ar,
    __wbg_newwithlength_e9b4878cebadb3d3: ur,
    __wbg_next_196c84450b364254: mn,
    __wbg_next_40fc327bfc8770e6: bn,
    __wbg_node_104a2ff8d6ea03a2: cn,
    __wbg_ownKeys_658942b7f28d1fe9: Kn,
    __wbg_process_4a72847cc503995b: _n,
    __wbg_push_a5b05aedc7234f9f: In,
    __wbg_randomFillSync_5c9c955aa56b6049: on,
    __wbg_require_cca90b1a94a0255b: un,
    __wbg_self_ce0dbfc45cf2f5be: tr,
    __wbg_set_1f9b04f170055d33: Xn,
    __wbg_set_20cbc34131e76824: nn,
    __wbg_set_a47bac70306a19a7: sr,
    __wbg_set_d4638f722068f043: En,
    __wbg_set_wasm: xt,
    __wbg_slice_52fb626ffdc8da8f: Qn,
    __wbg_stack_658279fe44541cf6: Yt,
    __wbg_subarray_a1f73cd4b5b42fe1: fr,
    __wbg_toString_7df3c77999517c20: er,
    __wbg_unshift_e22df4b34bcf5070: Mn,
    __wbg_value_d93c65011f51a456: vn,
    __wbg_values_9c75e6e2bfbdb70d: Un,
    __wbg_versions_f686565e586dd935: sn,
    __wbg_window_c6fb939a7f436783: nr,
    __wbindgen_bigint_from_i64: en,
    __wbindgen_bigint_from_u64: tn,
    __wbindgen_boolean_get: Vt,
    __wbindgen_debug_string: lr,
    __wbindgen_error_new: jt,
    __wbindgen_is_array: Jt,
    __wbindgen_is_function: Wt,
    __wbindgen_is_null: Lt,
    __wbindgen_is_object: qt,
    __wbindgen_is_string: Ut,
    __wbindgen_is_undefined: Ft,
    __wbindgen_json_serialize: Kt,
    __wbindgen_jsval_loose_eq: Qt,
    __wbindgen_memory: dr,
    __wbindgen_number_get: zt,
    __wbindgen_number_new: Ht,
    __wbindgen_object_clone_ref: Nt,
    __wbindgen_object_drop_ref: Dt,
    __wbindgen_string_get: Bt,
    __wbindgen_string_new: $t,
    __wbindgen_throw: gr,
    create: $o,
    decodeChange: zo,
    decodeSyncMessage: Wo,
    decodeSyncState: Jo,
    encodeChange: No,
    encodeSyncMessage: Uo,
    encodeSyncState: qo,
    exportSyncState: Lo,
    importSyncState: Vo,
    initSyncState: Fo,
    load: Ho
  }, Symbol.toStringTag, {
    value: "Module"
  })), L = Symbol.for("_am_meta"), G = Symbol.for("_am_trace"), Q = Symbol.for("_am_objectId"), Ce = Symbol.for("_am_isProxy"), pr = Symbol.for("_am_clearCache"), $_ = Symbol.for("_am_uint"), H_ = Symbol.for("_am_int"), N_ = Symbol.for("_am_f64"), hr = Symbol.for("_am_counter"), z_ = Symbol.for("_am_text");
  class z {
    constructor(e) {
      if (typeof e == "string") this.elems = [
        ...e
      ];
      else if (Array.isArray(e)) this.elems = e;
      else if (e === void 0) this.elems = [];
      else throw new TypeError(`Unsupported initial value for Text: ${e}`);
      Reflect.defineProperty(this, z_, {
        value: true
      });
    }
    get length() {
      return this.elems.length;
    }
    get(e) {
      return this.elems[e];
    }
    [Symbol.iterator]() {
      const e = this.elems;
      let n = -1;
      return {
        next() {
          return n += 1, n < e.length ? {
            done: false,
            value: e[n]
          } : {
            done: true
          };
        }
      };
    }
    toString() {
      if (!this.str) {
        this.str = "";
        for (const e of this.elems) typeof e == "string" ? this.str += e : this.str += "\uFFFC";
      }
      return this.str;
    }
    toSpans() {
      if (!this.spans) {
        this.spans = [];
        let e = "";
        for (const n of this.elems) typeof n == "string" ? e += n : (e.length > 0 && (this.spans.push(e), e = ""), this.spans.push(n));
        e.length > 0 && this.spans.push(e);
      }
      return this.spans;
    }
    toJSON() {
      return this.toString();
    }
    set(e, n) {
      if (this[L]) throw new RangeError("object cannot be modified outside of a change block");
      this.elems[e] = n;
    }
    insertAt(e, ...n) {
      if (this[L]) throw new RangeError("object cannot be modified outside of a change block");
      n.every((r) => typeof r == "string") ? this.elems.splice(e, 0, ...n.join("")) : this.elems.splice(e, 0, ...n);
    }
    deleteAt(e, n = 1) {
      if (this[L]) throw new RangeError("object cannot be modified outside of a change block");
      this.elems.splice(e, n);
    }
    map(e) {
      this.elems.map(e);
    }
    lastIndexOf(e, n) {
      this.elems.lastIndexOf(e, n);
    }
    concat(e) {
      return new z(this.elems.concat(e.elems));
    }
    every(e) {
      return this.elems.every(e);
    }
    filter(e) {
      return new z(this.elems.filter(e));
    }
    find(e) {
      return this.elems.find(e);
    }
    findIndex(e) {
      return this.elems.findIndex(e);
    }
    forEach(e) {
      this.elems.forEach(e);
    }
    includes(e) {
      return this.elems.includes(e);
    }
    indexOf(e) {
      return this.elems.indexOf(e);
    }
    join(e) {
      return this.elems.join(e);
    }
    reduce(e) {
      this.elems.reduce(e);
    }
    reduceRight(e) {
      this.elems.reduceRight(e);
    }
    slice(e, n) {
      return new z(this.elems.slice(e, n));
    }
    some(e) {
      return this.elems.some(e);
    }
    toLocaleString() {
      this.toString();
    }
  }
  class $e {
    constructor(e) {
      this.value = e || 0, Reflect.defineProperty(this, hr, {
        value: true
      });
    }
    valueOf() {
      return this.value;
    }
    toString() {
      return this.valueOf().toString();
    }
    toJSON() {
      return this.value;
    }
    increment(e) {
      throw new Error("Counters should not be incremented outside of a change callback");
    }
    decrement(e) {
      throw new Error("Counters should not be decremented outside of a change callback");
    }
  }
  class F_ extends $e {
    constructor(e, n, r, o, a) {
      super(e), this.context = n, this.path = r, this.objectId = o, this.key = a;
    }
    increment(e) {
      return e = typeof e == "number" ? e : 1, this.context.increment(this.objectId, this.key, e), this.value += e, this.value;
    }
    decrement(e) {
      return this.increment(typeof e == "number" ? -e : -1);
    }
  }
  function V_(t, e, n, r, o) {
    return new F_(t, e, n, r, o);
  }
  class He {
    constructor(e) {
      this.val = e;
    }
    toString() {
      return this.val;
    }
    toJSON() {
      return this.val;
    }
  }
  function $(t) {
    if (typeof t == "string" && /^[0-9]+$/.test(t) && (t = parseInt(t, 10)), typeof t != "number") return t;
    if (t < 0 || isNaN(t) || t === 1 / 0 || t === -1 / 0) throw new RangeError("A list index must be positive, but you passed " + t);
    return t;
  }
  function x(t, e) {
    const { context: n, objectId: r, path: o, textV2: a } = t, _ = n.getWithType(r, e);
    if (_ === null) return;
    const s = _[0], f = _[1];
    switch (s) {
      case void 0:
        return;
      case "map":
        return ie(n, f, a, [
          ...o,
          e
        ]);
      case "list":
        return Re(n, f, a, [
          ...o,
          e
        ]);
      case "text":
        return a ? n.text(f) : oe(n, f, [
          ...o,
          e
        ]);
      case "str":
        return f;
      case "uint":
        return f;
      case "int":
        return f;
      case "f64":
        return f;
      case "boolean":
        return f;
      case "null":
        return null;
      case "bytes":
        return f;
      case "timestamp":
        return f;
      case "counter":
        return V_(f, n, o, r, e);
      default:
        throw RangeError(`datatype ${s} unimplemented`);
    }
  }
  function ve(t, e, n, r) {
    const o = typeof t;
    switch (o) {
      case "object":
        if (t == null) return [
          null,
          "null"
        ];
        if (t[$_]) return [
          t.value,
          "uint"
        ];
        if (t[H_]) return [
          t.value,
          "int"
        ];
        if (t[N_]) return [
          t.value,
          "f64"
        ];
        if (t[hr]) return [
          t.value,
          "counter"
        ];
        if (t instanceof Date) return [
          t.getTime(),
          "timestamp"
        ];
        if (t instanceof He) return [
          t.toString(),
          "str"
        ];
        if (t instanceof z) return [
          t,
          "text"
        ];
        if (t instanceof Uint8Array) return [
          t,
          "bytes"
        ];
        if (t instanceof Array) return [
          t,
          "list"
        ];
        if (Object.prototype.toString.call(t) === "[object Object]") return [
          t,
          "map"
        ];
        throw Ee(t, r) ? new RangeError("Cannot create a reference to an existing document object") : new RangeError(`Cannot assign unknown object: ${t}`);
      case "boolean":
        return [
          t,
          "boolean"
        ];
      case "number":
        return Number.isInteger(t) ? [
          t,
          "int"
        ] : [
          t,
          "f64"
        ];
      case "string":
        return e ? [
          t,
          "text"
        ] : [
          t,
          "str"
        ];
      case "undefined":
        throw new RangeError([
          `Cannot assign undefined value at ${dt(n)}, `,
          "because `undefined` is not a valid JSON data type. ",
          "You might consider setting the property's value to `null`, ",
          "or using `delete` to remove it altogether."
        ].join(""));
      default:
        throw new RangeError([
          `Cannot assign ${o} value at ${dt(n)}. `,
          "All JSON primitive datatypes (object, array, string, number, boolean, null) ",
          `are supported in an Automerge document; ${o} values are not. `
        ].join(""));
    }
  }
  function Ee(t, e) {
    var n, r;
    return t instanceof Date ? false : !!(t && ((r = (n = t[L]) === null || n === void 0 ? void 0 : n.handle) === null || r === void 0 ? void 0 : r.__wbg_ptr) === e.__wbg_ptr);
  }
  const L_ = {
    get(t, e) {
      const { context: n, objectId: r, cache: o } = t;
      return e === Symbol.toStringTag ? t[Symbol.toStringTag] : e === Q ? r : e === Ce ? true : e === G ? t.trace : e === L ? {
        handle: n,
        textV2: t.textV2
      } : (o[e] || (o[e] = x(t, e)), o[e]);
    },
    set(t, e, n) {
      const { context: r, objectId: o, path: a, textV2: _ } = t;
      if (t.cache = {}, Ee(n, r)) throw new RangeError("Cannot create a reference to an existing document object");
      if (e === G) return t.trace = n, true;
      if (e === pr) return true;
      const [s, f] = ve(n, _, [
        ...a,
        e
      ], r);
      switch (f) {
        case "list": {
          const g = r.putObject(o, e, []), w = Re(r, g, _, [
            ...a,
            e
          ]);
          for (let h = 0; h < s.length; h++) w[h] = s[h];
          break;
        }
        case "text": {
          if (_) Se(s), r.putObject(o, e, s);
          else {
            Ke(s);
            const g = r.putObject(o, e, "");
            oe(r, g, [
              ...a,
              e
            ]).splice(0, 0, ...s);
          }
          break;
        }
        case "map": {
          const g = r.putObject(o, e, {}), w = ie(r, g, _, [
            ...a,
            e
          ]);
          for (const h in s) w[h] = s[h];
          break;
        }
        default:
          r.put(o, e, s, f);
      }
      return true;
    },
    deleteProperty(t, e) {
      const { context: n, objectId: r } = t;
      return t.cache = {}, n.delete(r, e), true;
    },
    has(t, e) {
      return this.get(t, e) !== void 0;
    },
    getOwnPropertyDescriptor(t, e) {
      const n = this.get(t, e);
      if (typeof n < "u") return {
        configurable: true,
        enumerable: true,
        value: n
      };
    },
    ownKeys(t) {
      const { context: e, objectId: n } = t, r = e.keys(n);
      return [
        ...new Set(r)
      ];
    }
  }, wr = {
    get(t, e) {
      const { context: n, objectId: r } = t;
      return e = $(e), e === Symbol.hasInstance ? (o) => Array.isArray(o) : e === Symbol.toStringTag ? t[Symbol.toStringTag] : e === Q ? r : e === Ce ? true : e === G ? t.trace : e === L ? {
        handle: n
      } : e === "length" ? n.length(r) : typeof e == "number" ? x(t, e) : Je(t)[e];
    },
    set(t, e, n) {
      const { context: r, objectId: o, path: a, textV2: _ } = t;
      if (e = $(e), Ee(n, r)) throw new RangeError("Cannot create a reference to an existing document object");
      if (e === pr) return true;
      if (e === G) return t.trace = n, true;
      if (typeof e == "string") throw new RangeError("list index must be a number");
      const [s, f] = ve(n, _, [
        ...a,
        e
      ], r);
      switch (f) {
        case "list": {
          let g;
          e >= r.length(o) ? g = r.insertObject(o, e, []) : g = r.putObject(o, e, []), Re(r, g, _, [
            ...a,
            e
          ]).splice(0, 0, ...s);
          break;
        }
        case "text": {
          if (_) Se(s), e >= r.length(o) ? r.insertObject(o, e, s) : r.putObject(o, e, s);
          else {
            let g;
            Ke(s), e >= r.length(o) ? g = r.insertObject(o, e, "") : g = r.putObject(o, e, ""), oe(r, g, [
              ...a,
              e
            ]).splice(0, 0, ...s);
          }
          break;
        }
        case "map": {
          let g;
          e >= r.length(o) ? g = r.insertObject(o, e, {}) : g = r.putObject(o, e, {});
          const w = ie(r, g, _, [
            ...a,
            e
          ]);
          for (const h in s) w[h] = s[h];
          break;
        }
        default:
          e >= r.length(o) ? r.insert(o, e, s, f) : r.put(o, e, s, f);
      }
      return true;
    },
    deleteProperty(t, e) {
      const { context: n, objectId: r } = t;
      e = $(e);
      const o = n.get(r, e);
      if (o != null && o[0] == "counter") throw new TypeError("Unsupported operation: deleting a counter from a list");
      return n.delete(r, e), true;
    },
    has(t, e) {
      const { context: n, objectId: r } = t;
      return e = $(e), typeof e == "number" ? e < n.length(r) : e === "length";
    },
    getOwnPropertyDescriptor(t, e) {
      const { context: n, objectId: r } = t;
      return e === "length" ? {
        writable: true,
        value: n.length(r)
      } : e === Q ? {
        configurable: false,
        enumerable: false,
        value: r
      } : (e = $(e), {
        configurable: true,
        enumerable: true,
        value: x(t, e)
      });
    },
    getPrototypeOf(t) {
      return Object.getPrototypeOf(t);
    },
    ownKeys() {
      const t = [];
      return t.push("length"), t;
    }
  }, U_ = Object.assign({}, wr, {
    get(t, e) {
      const { context: n, objectId: r } = t;
      return e = $(e), e === Symbol.hasInstance ? (o) => Array.isArray(o) : e === Symbol.toStringTag ? t[Symbol.toStringTag] : e === Q ? r : e === Ce ? true : e === G ? t.trace : e === L ? {
        handle: n
      } : e === "length" ? n.length(r) : typeof e == "number" ? x(t, e) : q_(t)[e] || Je(t)[e];
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(new z());
    }
  });
  function ie(t, e, n, r) {
    const o = {
      context: t,
      objectId: e,
      path: r || [],
      cache: {},
      textV2: n
    }, a = {};
    return Object.assign(a, o), new Proxy(a, L_);
  }
  function Re(t, e, n, r) {
    const o = {
      context: t,
      objectId: e,
      path: r || [],
      cache: {},
      textV2: n
    }, a = [];
    return Object.assign(a, o), new Proxy(a, wr);
  }
  function oe(t, e, n) {
    const r = {
      context: t,
      objectId: e,
      path: n || [],
      cache: {},
      textV2: false
    }, o = {};
    return Object.assign(o, r), new Proxy(o, U_);
  }
  function W_(t, e) {
    return ie(t, "_root", e, []);
  }
  function Je(t) {
    const { context: e, objectId: n, path: r, textV2: o } = t;
    return {
      deleteAt(_, s) {
        return typeof s == "number" ? e.splice(n, _, s) : e.delete(n, _), this;
      },
      fill(_, s, f) {
        const [g, w] = ve(_, o, [
          ...r,
          s
        ], e), h = e.length(n);
        s = $(s || 0), f = $(f || h);
        for (let y = s; y < Math.min(f, h); y++) if (w === "list" || w === "map") e.putObject(n, y, g);
        else if (w === "text") if (o) Se(g), e.putObject(n, y, g);
        else {
          Ke(g);
          const O = e.putObject(n, y, ""), ne = oe(e, O, [
            ...r,
            y
          ]);
          for (let W = 0; W < g.length; W++) ne[W] = g.get(W);
        }
        else e.put(n, y, g, w);
        return this;
      },
      indexOf(_, s = 0) {
        const f = e.length(n);
        for (let g = s; g < f; g++) {
          const w = e.getWithType(n, g);
          if (w && (w[1] === _[Q] || w[1] === _)) return g;
        }
        return -1;
      },
      insertAt(_, ...s) {
        return this.splice(_, 0, ...s), this;
      },
      pop() {
        const _ = e.length(n);
        if (_ == 0) return;
        const s = x(t, _ - 1);
        return e.delete(n, _ - 1), s;
      },
      push(..._) {
        const s = e.length(n);
        return this.splice(s, 0, ..._), e.length(n);
      },
      shift() {
        if (e.length(n) == 0) return;
        const _ = x(t, 0);
        return e.delete(n, 0), _;
      },
      splice(_, s, ...f) {
        _ = $(_), typeof s != "number" && (s = e.length(n) - _), s = $(s);
        for (const h of f) if (Ee(h, e)) throw new RangeError("Cannot create a reference to an existing document object");
        const g = [];
        for (let h = 0; h < s; h++) {
          const y = x(t, _);
          y !== void 0 && g.push(y), e.delete(n, _);
        }
        const w = f.map((h, y) => {
          try {
            return ve(h, o, [
              ...r
            ], e);
          } catch (O) {
            throw O instanceof RangeError ? new RangeError(`${O.message} (at index ${y} in the input)`) : O;
          }
        });
        for (const [h, y] of w) {
          switch (y) {
            case "list": {
              const O = e.insertObject(n, _, []);
              Re(e, O, o, [
                ...r,
                _
              ]).splice(0, 0, ...h);
              break;
            }
            case "text": {
              if (o) Se(h), e.insertObject(n, _, h);
              else {
                const O = e.insertObject(n, _, "");
                oe(e, O, [
                  ...r,
                  _
                ]).splice(0, 0, ...h);
              }
              break;
            }
            case "map": {
              const O = e.insertObject(n, _, {}), ne = ie(e, O, o, [
                ...r,
                _
              ]);
              for (const W in h) ne[W] = h[W];
              break;
            }
            default:
              e.insert(n, _, h, y);
          }
          _ += 1;
        }
        return g;
      },
      unshift(..._) {
        return this.splice(0, 0, ..._), e.length(n);
      },
      entries() {
        let _ = 0;
        return {
          next: () => {
            const f = x(t, _);
            return f === void 0 ? {
              value: void 0,
              done: true
            } : {
              value: [
                _++,
                f
              ],
              done: false
            };
          },
          [Symbol.iterator]() {
            return this;
          }
        };
      },
      keys() {
        let _ = 0;
        const s = e.length(n);
        return {
          next: () => _ < s ? {
            value: _++,
            done: false
          } : {
            value: void 0,
            done: true
          },
          [Symbol.iterator]() {
            return this;
          }
        };
      },
      values() {
        let _ = 0;
        return {
          next: () => {
            const f = x(t, _++);
            return f === void 0 ? {
              value: void 0,
              done: true
            } : {
              value: f,
              done: false
            };
          },
          [Symbol.iterator]() {
            return this;
          }
        };
      },
      toArray() {
        const _ = [];
        let s;
        do
          s = x(t, _.length), s !== void 0 && _.push(s);
        while (s !== void 0);
        return _;
      },
      map(_) {
        return this.toArray().map(_);
      },
      toString() {
        return this.toArray().toString();
      },
      toLocaleString() {
        return this.toArray().toLocaleString();
      },
      forEach(_) {
        return this.toArray().forEach(_);
      },
      concat(_) {
        return this.toArray().concat(_);
      },
      every(_) {
        return this.toArray().every(_);
      },
      filter(_) {
        return this.toArray().filter(_);
      },
      find(_) {
        let s = 0;
        for (const f of this) {
          if (_(f, s)) return f;
          s += 1;
        }
      },
      findIndex(_) {
        let s = 0;
        for (const f of this) {
          if (_(f, s)) return s;
          s += 1;
        }
        return -1;
      },
      includes(_) {
        return this.find((s) => s === _) !== void 0;
      },
      join(_) {
        return this.toArray().join(_);
      },
      reduce(_, s) {
        return this.toArray().reduce(_, s);
      },
      reduceRight(_, s) {
        return this.toArray().reduceRight(_, s);
      },
      lastIndexOf(_, s = 1 / 0) {
        return this.toArray().lastIndexOf(_, s);
      },
      slice(_, s) {
        return this.toArray().slice(_, s);
      },
      some(_) {
        let s = 0;
        for (const f of this) {
          if (_(f, s)) return true;
          s += 1;
        }
        return false;
      },
      [Symbol.iterator]: function* () {
        let _ = 0, s = x(t, _);
        for (; s !== void 0; ) yield s, _ += 1, s = x(t, _);
      }
    };
  }
  function q_(t) {
    const { context: e, objectId: n } = t;
    return {
      set(o, a) {
        return this[o] = a;
      },
      get(o) {
        return this[o];
      },
      toString() {
        return e.text(n).replace(/￼/g, "");
      },
      toSpans() {
        const o = [];
        let a = "";
        const _ = e.length(n);
        for (let s = 0; s < _; s++) {
          const f = this[s];
          typeof f == "string" ? a += f : (a.length > 0 && (o.push(a), a = ""), o.push(f));
        }
        return a.length > 0 && o.push(a), o;
      },
      toJSON() {
        return this.toString();
      },
      indexOf(o, a = 0) {
        return e.text(n).indexOf(o, a);
      },
      insertAt(o, ...a) {
        a.every((_) => typeof _ == "string") ? e.splice(n, o, 0, a.join("")) : Je(t).insertAt(o, ...a);
      }
    };
  }
  function Ke(t) {
    if (!(t instanceof z)) throw new Error("value was not a Text instance");
  }
  function Se(t) {
    if (typeof t != "string") throw new Error("value was not a string");
  }
  function dt(t) {
    const e = t.map((n) => {
      if (typeof n == "number") return n.toString();
      if (typeof n == "string") return n.replace(/~/g, "~0").replace(/\//g, "~1");
    });
    return t.length === 0 ? "" : "/" + e.join("/");
  }
  function I(t, e = true) {
    if (typeof t != "object") throw new RangeError("must be the document root");
    const n = Reflect.get(t, L);
    if (n === void 0 || n == null || e && J_(t) !== "_root") throw new RangeError("must be the document root");
    return n;
  }
  function br(t) {
    return Reflect.get(t, G);
  }
  function J_(t) {
    return typeof t != "object" || t === null ? null : Reflect.get(t, Q);
  }
  function Xe(t) {
    return !!Reflect.get(t, Ce);
  }
  function mr(t) {
    return typeof t == "object" ? t : {
      actor: t
    };
  }
  xi = function(t) {
    const e = mr(t), n = !!e.freeze, r = e.patchCallback, o = !e.enableTextV2, a = e.actor, _ = H.create({
      actor: a,
      text_v1: o
    });
    _.enableFreeze(!!e.freeze);
    const s = e.enableTextV2 || false;
    return yr(_, s), _.materialize("/", void 0, {
      handle: _,
      heads: void 0,
      freeze: n,
      patchCallback: r,
      textV2: s
    });
  };
  Pi = function(t, e, n) {
    if (typeof e == "function") return K_(t, "change", {}, e).newDoc;
    throw RangeError("Invalid args for change");
  };
  function Te(t, e, n, r) {
    if (n == null) return t;
    const o = I(t), a = Object.assign(Object.assign({}, o), {
      heads: void 0
    }), { value: _, patches: s } = o.handle.applyAndReturnPatches(t, a);
    if (s.length > 0) {
      r?.(s, {
        before: t,
        after: _,
        source: e
      });
      const f = I(_);
      f.mostRecentPatch = {
        before: I(t).heads,
        after: f.handle.getHeads(),
        patches: s
      };
    }
    return o.heads = n, _;
  }
  function K_(t, e, n, r, o) {
    if (typeof r != "function") throw new RangeError("invalid change function");
    const a = I(t);
    if (t === void 0 || a === void 0) throw new RangeError("must be the document root");
    if (a.heads) throw new RangeError("Attempting to change an outdated document.  Use Automerge.clone() if you wish to make a writable copy.");
    if (Xe(t)) throw new RangeError("Calls to Automerge.change cannot be nested");
    let _ = a.handle.getHeads();
    "time" in n || (n.time = Math.floor(Date.now() / 1e3));
    try {
      a.heads = _;
      const s = W_(a.handle, a.textV2);
      if (r(s), a.handle.pendingOps() === 0) return a.heads = void 0, {
        newDoc: t,
        newHeads: null
      };
      {
        const f = a.handle.commit(n.message, n.time);
        return a.handle.integrate(), {
          newDoc: Te(t, e, _, n.patchCallback || a.patchCallback),
          newHeads: f != null ? [
            f
          ] : null
        };
      }
    } catch (s) {
      throw a.heads = void 0, a.handle.rollback(), s;
    }
  }
  Di = function(t, e) {
    const n = mr(e), r = n.actor, o = n.patchCallback, a = !n.enableTextV2, _ = n.unchecked || false, s = n.allowMissingChanges || false, f = n.convertRawStringsToText || false, g = H.load(t, {
      text_v1: a,
      actor: r,
      unchecked: _,
      allowMissingDeps: s,
      convertRawStringsToText: f
    });
    g.enableFreeze(!!n.freeze);
    const w = n.enableTextV2 || false;
    return yr(g, w), g.materialize("/", void 0, {
      handle: g,
      heads: void 0,
      patchCallback: o,
      textV2: w
    });
  };
  Bi = function(t, e, n) {
    n || (n = {});
    const r = I(t);
    if (r.heads) throw new RangeError("Attempting to change an out of date document - set at: " + br(t));
    if (Xe(t)) throw new RangeError("Calls to Automerge.change cannot be nested");
    const o = r.handle.getHeads();
    return r.handle.loadIncremental(e), Te(t, "loadIncremental", o, n.patchCallback || r.patchCallback);
  };
  ji = function(t) {
    return I(t).handle.save();
  };
  $i = function(t, e) {
    const n = I(t);
    if (n.heads) throw new RangeError("Attempting to change an out of date document - set at: " + br(t));
    const r = n.handle.getHeads(), o = I(e), a = n.handle.getChangesAdded(o.handle);
    return n.handle.applyChanges(a), Te(t, "merge", r, n.patchCallback);
  };
  Hi = function(t) {
    return I(t).handle.getChanges([]);
  };
  Ni = function(t, e, n) {
    pt(e, "before"), pt(n, "after");
    const r = I(t);
    return r.mostRecentPatch && Ne(r.mostRecentPatch.before, e) && Ne(r.mostRecentPatch.after, n) ? r.mostRecentPatch.patches : r.handle.diff(e, n);
  };
  function pt(t, e) {
    if (!Array.isArray(t)) throw new Error(`${e} must be an array`);
  }
  function Ne(t, e) {
    if (!ht(t) || !ht(e)) return t === e;
    const n = Object.keys(t).sort(), r = Object.keys(e).sort();
    if (n.length !== r.length) return false;
    for (let o = 0; o < n.length; o++) if (n[o] !== r[o] || !Ne(t[n[o]], e[r[o]])) return false;
    return true;
  }
  zi = function(t, e) {
    const n = I(t), r = H.importSyncState(e), o = n.handle.generateSyncMessage(r);
    return [
      H.exportSyncState(r),
      o
    ];
  };
  Fi = function(t, e, n, r) {
    const o = H.importSyncState(e);
    r || (r = {});
    const a = I(t);
    if (a.heads) throw new RangeError("Attempting to change an outdated document.  Use Automerge.clone() if you wish to make a writable copy.");
    if (Xe(t)) throw new RangeError("Calls to Automerge.change cannot be nested");
    const _ = a.handle.getHeads();
    a.handle.receiveSyncMessage(o, n);
    const s = H.exportSyncState(o);
    return [
      Te(t, "receiveSyncMessage", _, r.patchCallback || a.patchCallback),
      s,
      null
    ];
  };
  Vi = function() {
    return H.exportSyncState(H.initSyncState());
  };
  Li = function(t) {
    return H.decodeChange(t);
  };
  Ui = function(t) {
    const e = I(t);
    return e.heads || e.handle.getHeads();
  };
  function ht(t) {
    return typeof t == "object" && t !== null;
  }
  function yr(t, e) {
    t.registerDatatype("counter", (n) => new $e(n), (n) => {
      if (n instanceof $e) return n.value;
    }), e ? t.registerDatatype("str", (n) => new He(n), (n) => {
      if (n instanceof He) return n.val;
    }) : t.registerDatatype("text", (n) => new z(n), (n) => {
      if (n instanceof z) return n.join("");
    });
  }
  Io(j_);
  Wi = function(t) {
    return t.replaceAll(/[^a-z0-9-\.]/gi, "");
  };
  const wt = {};
  qi = async function(t) {
    if (wt[t]) return wt[t];
    try {
      return await (await fetch(`https://plc.directory/${t}`)).json();
    } catch {
    }
  };
  const he = {};
  Ji = async function(t) {
    if (he[t]) return he[t];
    const n = await (await fetch(`https://keyserver.roomy.chat/xrpc/chat.roomy.v0.key.public?did=${encodeURIComponent(t)}`)).json();
    return he[t] = Oo(n.publicKey), he[t];
  };
  Ki = function(t) {
    return t.kind !== void 0;
  };
  let X_, Y_;
  X_ = {};
  Y_ = Object.freeze(Object.defineProperty({
    __proto__: null,
    default: X_
  }, Symbol.toStringTag, {
    value: "Module"
  }));
  Xi = Co(Y_);
  var vr = "1.13.7", bt = typeof self == "object" && self.self === self && self || typeof global == "object" && global.global === global && global || Function("return this")() || {}, Ie = Array.prototype, Ye = Object.prototype, mt = typeof Symbol < "u" ? Symbol.prototype : null, G_ = Ie.push, ce = Ie.slice, ae = Ye.toString, Q_ = Ye.hasOwnProperty, Sr = typeof ArrayBuffer < "u", Z_ = typeof DataView < "u", es = Array.isArray, yt = Object.keys, vt = Object.create, St = Sr && ArrayBuffer.isView, ts = isNaN, ns = isFinite, kr = !{
    toString: null
  }.propertyIsEnumerable("toString"), kt = [
    "valueOf",
    "isPrototypeOf",
    "toString",
    "propertyIsEnumerable",
    "hasOwnProperty",
    "toLocaleString"
  ], rs = Math.pow(2, 53) - 1;
  function C(t, e) {
    return e = e == null ? t.length - 1 : +e, function() {
      for (var n = Math.max(arguments.length - e, 0), r = Array(n), o = 0; o < n; o++) r[o] = arguments[o + e];
      switch (e) {
        case 0:
          return t.call(this, r);
        case 1:
          return t.call(this, arguments[0], r);
        case 2:
          return t.call(this, arguments[0], arguments[1], r);
      }
      var a = Array(e + 1);
      for (o = 0; o < e; o++) a[o] = arguments[o];
      return a[e] = r, t.apply(this, a);
    };
  }
  function K(t) {
    var e = typeof t;
    return e === "function" || e === "object" && !!t;
  }
  function os(t) {
    return t === null;
  }
  function Ar(t) {
    return t === void 0;
  }
  function Or(t) {
    return t === true || t === false || ae.call(t) === "[object Boolean]";
  }
  function as(t) {
    return !!(t && t.nodeType === 1);
  }
  function S(t) {
    var e = "[object " + t + "]";
    return function(n) {
      return ae.call(n) === e;
    };
  }
  const Ge = S("String"), Cr = S("Number"), _s = S("Date"), ss = S("RegExp"), is = S("Error"), Er = S("Symbol"), Rr = S("ArrayBuffer");
  var Tr = S("Function"), cs = bt.document && bt.document.childNodes;
  typeof /./ != "function" && typeof Int8Array != "object" && typeof cs != "function" && (Tr = function(t) {
    return typeof t == "function" || false;
  });
  const k = Tr, Ir = S("Object");
  var Mr = Z_ && (!/\[native code\]/.test(String(DataView)) || Ir(new DataView(new ArrayBuffer(8)))), Qe = typeof Map < "u" && Ir(/* @__PURE__ */ new Map()), us = S("DataView");
  function fs(t) {
    return t != null && k(t.getInt8) && Rr(t.buffer);
  }
  const ke = Mr ? fs : us, X = es || S("Array");
  function U(t, e) {
    return t != null && Q_.call(t, e);
  }
  var ze = S("Arguments");
  (function() {
    ze(arguments) || (ze = function(t) {
      return U(t, "callee");
    });
  })();
  const Ze = ze;
  function ls(t) {
    return !Er(t) && ns(t) && !isNaN(parseFloat(t));
  }
  function xr(t) {
    return Cr(t) && ts(t);
  }
  function Pr(t) {
    return function() {
      return t;
    };
  }
  function Dr(t) {
    return function(e) {
      var n = t(e);
      return typeof n == "number" && n >= 0 && n <= rs;
    };
  }
  function Br(t) {
    return function(e) {
      return e?.[t];
    };
  }
  const Ae = Br("byteLength"), gs = Dr(Ae);
  var ds = /\[object ((I|Ui)nt(8|16|32)|Float(32|64)|Uint8Clamped|Big(I|Ui)nt64)Array\]/;
  function ps(t) {
    return St ? St(t) && !ke(t) : gs(t) && ds.test(ae.call(t));
  }
  const jr = Sr ? ps : Pr(false), E = Br("length");
  function hs(t) {
    for (var e = {}, n = t.length, r = 0; r < n; ++r) e[t[r]] = true;
    return {
      contains: function(o) {
        return e[o] === true;
      },
      push: function(o) {
        return e[o] = true, t.push(o);
      }
    };
  }
  function $r(t, e) {
    e = hs(e);
    var n = kt.length, r = t.constructor, o = k(r) && r.prototype || Ye, a = "constructor";
    for (U(t, a) && !e.contains(a) && e.push(a); n--; ) a = kt[n], a in t && t[a] !== o[a] && !e.contains(a) && e.push(a);
  }
  function v(t) {
    if (!K(t)) return [];
    if (yt) return yt(t);
    var e = [];
    for (var n in t) U(t, n) && e.push(n);
    return kr && $r(t, e), e;
  }
  function ws(t) {
    if (t == null) return true;
    var e = E(t);
    return typeof e == "number" && (X(t) || Ge(t) || Ze(t)) ? e === 0 : E(v(t)) === 0;
  }
  function Hr(t, e) {
    var n = v(e), r = n.length;
    if (t == null) return !r;
    for (var o = Object(t), a = 0; a < r; a++) {
      var _ = n[a];
      if (e[_] !== o[_] || !(_ in o)) return false;
    }
    return true;
  }
  function b(t) {
    if (t instanceof b) return t;
    if (!(this instanceof b)) return new b(t);
    this._wrapped = t;
  }
  b.VERSION = vr;
  b.prototype.value = function() {
    return this._wrapped;
  };
  b.prototype.valueOf = b.prototype.toJSON = b.prototype.value;
  b.prototype.toString = function() {
    return String(this._wrapped);
  };
  function At(t) {
    return new Uint8Array(t.buffer || t, t.byteOffset || 0, Ae(t));
  }
  var Ot = "[object DataView]";
  function Fe(t, e, n, r) {
    if (t === e) return t !== 0 || 1 / t === 1 / e;
    if (t == null || e == null) return false;
    if (t !== t) return e !== e;
    var o = typeof t;
    return o !== "function" && o !== "object" && typeof e != "object" ? false : Nr(t, e, n, r);
  }
  function Nr(t, e, n, r) {
    t instanceof b && (t = t._wrapped), e instanceof b && (e = e._wrapped);
    var o = ae.call(t);
    if (o !== ae.call(e)) return false;
    if (Mr && o == "[object Object]" && ke(t)) {
      if (!ke(e)) return false;
      o = Ot;
    }
    switch (o) {
      case "[object RegExp]":
      case "[object String]":
        return "" + t == "" + e;
      case "[object Number]":
        return +t != +t ? +e != +e : +t == 0 ? 1 / +t === 1 / e : +t == +e;
      case "[object Date]":
      case "[object Boolean]":
        return +t == +e;
      case "[object Symbol]":
        return mt.valueOf.call(t) === mt.valueOf.call(e);
      case "[object ArrayBuffer]":
      case Ot:
        return Nr(At(t), At(e), n, r);
    }
    var a = o === "[object Array]";
    if (!a && jr(t)) {
      var _ = Ae(t);
      if (_ !== Ae(e)) return false;
      if (t.buffer === e.buffer && t.byteOffset === e.byteOffset) return true;
      a = true;
    }
    if (!a) {
      if (typeof t != "object" || typeof e != "object") return false;
      var s = t.constructor, f = e.constructor;
      if (s !== f && !(k(s) && s instanceof s && k(f) && f instanceof f) && "constructor" in t && "constructor" in e) return false;
    }
    n = n || [], r = r || [];
    for (var g = n.length; g--; ) if (n[g] === t) return r[g] === e;
    if (n.push(t), r.push(e), a) {
      if (g = t.length, g !== e.length) return false;
      for (; g--; ) if (!Fe(t[g], e[g], n, r)) return false;
    } else {
      var w = v(t), h;
      if (g = w.length, v(e).length !== g) return false;
      for (; g--; ) if (h = w[g], !(U(e, h) && Fe(t[h], e[h], n, r))) return false;
    }
    return n.pop(), r.pop(), true;
  }
  function bs(t, e) {
    return Fe(t, e);
  }
  function ue(t) {
    if (!K(t)) return [];
    var e = [];
    for (var n in t) e.push(n);
    return kr && $r(t, e), e;
  }
  function et(t) {
    var e = E(t);
    return function(n) {
      if (n == null) return false;
      var r = ue(n);
      if (E(r)) return false;
      for (var o = 0; o < e; o++) if (!k(n[t[o]])) return false;
      return t !== Vr || !k(n[tt]);
    };
  }
  var tt = "forEach", zr = "has", nt = [
    "clear",
    "delete"
  ], Fr = [
    "get",
    zr,
    "set"
  ], ms = nt.concat(tt, Fr), Vr = nt.concat(Fr), ys = [
    "add"
  ].concat(nt, tt, zr);
  const vs = Qe ? et(ms) : S("Map"), Ss = Qe ? et(Vr) : S("WeakMap"), ks = Qe ? et(ys) : S("Set"), As = S("WeakSet");
  function ee(t) {
    for (var e = v(t), n = e.length, r = Array(n), o = 0; o < n; o++) r[o] = t[e[o]];
    return r;
  }
  function Os(t) {
    for (var e = v(t), n = e.length, r = Array(n), o = 0; o < n; o++) r[o] = [
      e[o],
      t[e[o]]
    ];
    return r;
  }
  function Lr(t) {
    for (var e = {}, n = v(t), r = 0, o = n.length; r < o; r++) e[t[n[r]]] = n[r];
    return e;
  }
  function Ve(t) {
    var e = [];
    for (var n in t) k(t[n]) && e.push(n);
    return e.sort();
  }
  function rt(t, e) {
    return function(n) {
      var r = arguments.length;
      if (e && (n = Object(n)), r < 2 || n == null) return n;
      for (var o = 1; o < r; o++) for (var a = arguments[o], _ = t(a), s = _.length, f = 0; f < s; f++) {
        var g = _[f];
        (!e || n[g] === void 0) && (n[g] = a[g]);
      }
      return n;
    };
  }
  const Ur = rt(ue), Oe = rt(v), Wr = rt(ue, true);
  function Cs() {
    return function() {
    };
  }
  function qr(t) {
    if (!K(t)) return {};
    if (vt) return vt(t);
    var e = Cs();
    e.prototype = t;
    var n = new e();
    return e.prototype = null, n;
  }
  function Es(t, e) {
    var n = qr(t);
    return e && Oe(n, e), n;
  }
  function Rs(t) {
    return K(t) ? X(t) ? t.slice() : Ur({}, t) : t;
  }
  function Ts(t, e) {
    return e(t), t;
  }
  function Jr(t) {
    return X(t) ? t : [
      t
    ];
  }
  b.toPath = Jr;
  function fe(t) {
    return b.toPath(t);
  }
  function ot(t, e) {
    for (var n = e.length, r = 0; r < n; r++) {
      if (t == null) return;
      t = t[e[r]];
    }
    return n ? t : void 0;
  }
  function Kr(t, e, n) {
    var r = ot(t, fe(e));
    return Ar(r) ? n : r;
  }
  function Is(t, e) {
    e = fe(e);
    for (var n = e.length, r = 0; r < n; r++) {
      var o = e[r];
      if (!U(t, o)) return false;
      t = t[o];
    }
    return !!n;
  }
  function at(t) {
    return t;
  }
  function _e(t) {
    return t = Oe({}, t), function(e) {
      return Hr(e, t);
    };
  }
  function _t(t) {
    return t = fe(t), function(e) {
      return ot(e, t);
    };
  }
  function le(t, e, n) {
    if (e === void 0) return t;
    switch (n ?? 3) {
      case 1:
        return function(r) {
          return t.call(e, r);
        };
      case 3:
        return function(r, o, a) {
          return t.call(e, r, o, a);
        };
      case 4:
        return function(r, o, a, _) {
          return t.call(e, r, o, a, _);
        };
    }
    return function() {
      return t.apply(e, arguments);
    };
  }
  function Xr(t, e, n) {
    return t == null ? at : k(t) ? le(t, e, n) : K(t) && !X(t) ? _e(t) : _t(t);
  }
  function st(t, e) {
    return Xr(t, e, 1 / 0);
  }
  b.iteratee = st;
  function R(t, e, n) {
    return b.iteratee !== st ? b.iteratee(t, e) : Xr(t, e, n);
  }
  function Ms(t, e, n) {
    e = R(e, n);
    for (var r = v(t), o = r.length, a = {}, _ = 0; _ < o; _++) {
      var s = r[_];
      a[s] = e(t[s], s, t);
    }
    return a;
  }
  function Yr() {
  }
  function xs(t) {
    return t == null ? Yr : function(e) {
      return Kr(t, e);
    };
  }
  function Ps(t, e, n) {
    var r = Array(Math.max(0, t));
    e = le(e, n, 1);
    for (var o = 0; o < t; o++) r[o] = e(o);
    return r;
  }
  function Le(t, e) {
    return e == null && (e = t, t = 0), t + Math.floor(Math.random() * (e - t + 1));
  }
  const se = Date.now || function() {
    return (/* @__PURE__ */ new Date()).getTime();
  };
  function Gr(t) {
    var e = function(a) {
      return t[a];
    }, n = "(?:" + v(t).join("|") + ")", r = RegExp(n), o = RegExp(n, "g");
    return function(a) {
      return a = a == null ? "" : "" + a, r.test(a) ? a.replace(o, e) : a;
    };
  }
  const Qr = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "`": "&#x60;"
  }, Ds = Gr(Qr), Bs = Lr(Qr), js = Gr(Bs), $s = b.templateSettings = {
    evaluate: /<%([\s\S]+?)%>/g,
    interpolate: /<%=([\s\S]+?)%>/g,
    escape: /<%-([\s\S]+?)%>/g
  };
  var Pe = /(.)^/, Hs = {
    "'": "'",
    "\\": "\\",
    "\r": "r",
    "\n": "n",
    "\u2028": "u2028",
    "\u2029": "u2029"
  }, Ns = /\\|'|\r|\n|\u2028|\u2029/g;
  function zs(t) {
    return "\\" + Hs[t];
  }
  var Fs = /^\s*(\w|\$)+\s*$/;
  function Vs(t, e, n) {
    !e && n && (e = n), e = Wr({}, e, b.templateSettings);
    var r = RegExp([
      (e.escape || Pe).source,
      (e.interpolate || Pe).source,
      (e.evaluate || Pe).source
    ].join("|") + "|$", "g"), o = 0, a = "__p+='";
    t.replace(r, function(g, w, h, y, O) {
      return a += t.slice(o, O).replace(Ns, zs), o = O + g.length, w ? a += `'+
((__t=(` + w + `))==null?'':_.escape(__t))+
'` : h ? a += `'+
((__t=(` + h + `))==null?'':__t)+
'` : y && (a += `';
` + y + `
__p+='`), g;
    }), a += `';
`;
    var _ = e.variable;
    if (_) {
      if (!Fs.test(_)) throw new Error("variable is not a bare identifier: " + _);
    } else a = `with(obj||{}){
` + a + `}
`, _ = "obj";
    a = `var __t,__p='',__j=Array.prototype.join,print=function(){__p+=__j.call(arguments,'');};
` + a + `return __p;
`;
    var s;
    try {
      s = new Function(_, "_", a);
    } catch (g) {
      throw g.source = a, g;
    }
    var f = function(g) {
      return s.call(this, g, b);
    };
    return f.source = "function(" + _ + `){
` + a + "}", f;
  }
  function Ls(t, e, n) {
    e = fe(e);
    var r = e.length;
    if (!r) return k(n) ? n.call(t) : n;
    for (var o = 0; o < r; o++) {
      var a = t?.[e[o]];
      a === void 0 && (a = n, o = r), t = k(a) ? a.call(t) : a;
    }
    return t;
  }
  var Us = 0;
  function Ws(t) {
    var e = ++Us + "";
    return t ? t + e : e;
  }
  function qs(t) {
    var e = b(t);
    return e._chain = true, e;
  }
  function Zr(t, e, n, r, o) {
    if (!(r instanceof e)) return t.apply(n, o);
    var a = qr(t.prototype), _ = t.apply(a, o);
    return K(_) ? _ : a;
  }
  var te = C(function(t, e) {
    var n = te.placeholder, r = function() {
      for (var o = 0, a = e.length, _ = Array(a), s = 0; s < a; s++) _[s] = e[s] === n ? arguments[o++] : e[s];
      for (; o < arguments.length; ) _.push(arguments[o++]);
      return Zr(t, r, this, this, _);
    };
    return r;
  });
  te.placeholder = b;
  const eo = C(function(t, e, n) {
    if (!k(t)) throw new TypeError("Bind must be called on a function");
    var r = C(function(o) {
      return Zr(t, r, e, this, n.concat(o));
    });
    return r;
  }), M = Dr(E);
  function Y(t, e, n, r) {
    if (r = r || [], !e && e !== 0) e = 1 / 0;
    else if (e <= 0) return r.concat(t);
    for (var o = r.length, a = 0, _ = E(t); a < _; a++) {
      var s = t[a];
      if (M(s) && (X(s) || Ze(s))) if (e > 1) Y(s, e - 1, n, r), o = r.length;
      else for (var f = 0, g = s.length; f < g; ) r[o++] = s[f++];
      else n || (r[o++] = s);
    }
    return r;
  }
  const Js = C(function(t, e) {
    e = Y(e, false, false);
    var n = e.length;
    if (n < 1) throw new Error("bindAll must be passed function names");
    for (; n--; ) {
      var r = e[n];
      t[r] = eo(t[r], t);
    }
    return t;
  });
  function Ks(t, e) {
    var n = function(r) {
      var o = n.cache, a = "" + (e ? e.apply(this, arguments) : r);
      return U(o, a) || (o[a] = t.apply(this, arguments)), o[a];
    };
    return n.cache = {}, n;
  }
  const to = C(function(t, e, n) {
    return setTimeout(function() {
      return t.apply(null, n);
    }, e);
  }), Xs = te(to, b, 1);
  function Ys(t, e, n) {
    var r, o, a, _, s = 0;
    n || (n = {});
    var f = function() {
      s = n.leading === false ? 0 : se(), r = null, _ = t.apply(o, a), r || (o = a = null);
    }, g = function() {
      var w = se();
      !s && n.leading === false && (s = w);
      var h = e - (w - s);
      return o = this, a = arguments, h <= 0 || h > e ? (r && (clearTimeout(r), r = null), s = w, _ = t.apply(o, a), r || (o = a = null)) : !r && n.trailing !== false && (r = setTimeout(f, h)), _;
    };
    return g.cancel = function() {
      clearTimeout(r), s = 0, r = o = a = null;
    }, g;
  }
  Gs = function(t, e, n) {
    var r, o, a, _, s, f = function() {
      var w = se() - o;
      e > w ? r = setTimeout(f, e - w) : (r = null, n || (_ = t.apply(s, a)), r || (a = s = null));
    }, g = C(function(w) {
      return s = this, a = w, o = se(), r || (r = setTimeout(f, e), n && (_ = t.apply(s, a))), _;
    });
    return g.cancel = function() {
      clearTimeout(r), r = a = s = null;
    }, g;
  };
  function Qs(t, e) {
    return te(e, t);
  }
  function it(t) {
    return function() {
      return !t.apply(this, arguments);
    };
  }
  function Zs() {
    var t = arguments, e = t.length - 1;
    return function() {
      for (var n = e, r = t[e].apply(this, arguments); n--; ) r = t[n].call(this, r);
      return r;
    };
  }
  function ei(t, e) {
    return function() {
      if (--t < 1) return e.apply(this, arguments);
    };
  }
  function no(t, e) {
    var n;
    return function() {
      return --t > 0 && (n = e.apply(this, arguments)), t <= 1 && (e = null), n;
    };
  }
  const ti = te(no, 2);
  function ro(t, e, n) {
    e = R(e, n);
    for (var r = v(t), o, a = 0, _ = r.length; a < _; a++) if (o = r[a], e(t[o], o, t)) return o;
  }
  function oo(t) {
    return function(e, n, r) {
      n = R(n, r);
      for (var o = E(e), a = t > 0 ? 0 : o - 1; a >= 0 && a < o; a += t) if (n(e[a], a, e)) return a;
      return -1;
    };
  }
  const ct = oo(1), ao = oo(-1);
  function _o(t, e, n, r) {
    n = R(n, r, 1);
    for (var o = n(e), a = 0, _ = E(t); a < _; ) {
      var s = Math.floor((a + _) / 2);
      n(t[s]) < o ? a = s + 1 : _ = s;
    }
    return a;
  }
  function so(t, e, n) {
    return function(r, o, a) {
      var _ = 0, s = E(r);
      if (typeof a == "number") t > 0 ? _ = a >= 0 ? a : Math.max(a + s, _) : s = a >= 0 ? Math.min(a + 1, s) : a + s + 1;
      else if (n && a && s) return a = n(r, o), r[a] === o ? a : -1;
      if (o !== o) return a = e(ce.call(r, _, s), xr), a >= 0 ? a + _ : -1;
      for (a = t > 0 ? _ : s - 1; a >= 0 && a < s; a += t) if (r[a] === o) return a;
      return -1;
    };
  }
  const io = so(1, ct, _o), ni = so(-1, ao);
  function Ue(t, e, n) {
    var r = M(t) ? ct : ro, o = r(t, e, n);
    if (o !== void 0 && o !== -1) return t[o];
  }
  function ri(t, e) {
    return Ue(t, _e(e));
  }
  function V(t, e, n) {
    e = le(e, n);
    var r, o;
    if (M(t)) for (r = 0, o = t.length; r < o; r++) e(t[r], r, t);
    else {
      var a = v(t);
      for (r = 0, o = a.length; r < o; r++) e(t[a[r]], a[r], t);
    }
    return t;
  }
  function J(t, e, n) {
    e = R(e, n);
    for (var r = !M(t) && v(t), o = (r || t).length, a = Array(o), _ = 0; _ < o; _++) {
      var s = r ? r[_] : _;
      a[_] = e(t[s], s, t);
    }
    return a;
  }
  function co(t) {
    var e = function(n, r, o, a) {
      var _ = !M(n) && v(n), s = (_ || n).length, f = t > 0 ? 0 : s - 1;
      for (a || (o = n[_ ? _[f] : f], f += t); f >= 0 && f < s; f += t) {
        var g = _ ? _[f] : f;
        o = r(o, n[g], g, n);
      }
      return o;
    };
    return function(n, r, o, a) {
      var _ = arguments.length >= 3;
      return e(n, le(r, a, 4), o, _);
    };
  }
  const De = co(1), Ct = co(-1);
  function Z(t, e, n) {
    var r = [];
    return e = R(e, n), V(t, function(o, a, _) {
      e(o, a, _) && r.push(o);
    }), r;
  }
  function oi(t, e, n) {
    return Z(t, it(R(e)), n);
  }
  function Et(t, e, n) {
    e = R(e, n);
    for (var r = !M(t) && v(t), o = (r || t).length, a = 0; a < o; a++) {
      var _ = r ? r[a] : a;
      if (!e(t[_], _, t)) return false;
    }
    return true;
  }
  function Rt(t, e, n) {
    e = R(e, n);
    for (var r = !M(t) && v(t), o = (r || t).length, a = 0; a < o; a++) {
      var _ = r ? r[a] : a;
      if (e(t[_], _, t)) return true;
    }
    return false;
  }
  function F(t, e, n, r) {
    return M(t) || (t = ee(t)), (typeof n != "number" || r) && (n = 0), io(t, e, n) >= 0;
  }
  const ai = C(function(t, e, n) {
    var r, o;
    return k(e) ? o = e : (e = fe(e), r = e.slice(0, -1), e = e[e.length - 1]), J(t, function(a) {
      var _ = o;
      if (!_) {
        if (r && r.length && (a = ot(a, r)), a == null) return;
        _ = a[e];
      }
      return _ == null ? _ : _.apply(a, n);
    });
  });
  function ut(t, e) {
    return J(t, _t(e));
  }
  function _i(t, e) {
    return Z(t, _e(e));
  }
  function uo(t, e, n) {
    var r = -1 / 0, o = -1 / 0, a, _;
    if (e == null || typeof e == "number" && typeof t[0] != "object" && t != null) {
      t = M(t) ? t : ee(t);
      for (var s = 0, f = t.length; s < f; s++) a = t[s], a != null && a > r && (r = a);
    } else e = R(e, n), V(t, function(g, w, h) {
      _ = e(g, w, h), (_ > o || _ === -1 / 0 && r === -1 / 0) && (r = g, o = _);
    });
    return r;
  }
  function si(t, e, n) {
    var r = 1 / 0, o = 1 / 0, a, _;
    if (e == null || typeof e == "number" && typeof t[0] != "object" && t != null) {
      t = M(t) ? t : ee(t);
      for (var s = 0, f = t.length; s < f; s++) a = t[s], a != null && a < r && (r = a);
    } else e = R(e, n), V(t, function(g, w, h) {
      _ = e(g, w, h), (_ < o || _ === 1 / 0 && r === 1 / 0) && (r = g, o = _);
    });
    return r;
  }
  var ii = /[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;
  function fo(t) {
    return t ? X(t) ? ce.call(t) : Ge(t) ? t.match(ii) : M(t) ? J(t, at) : ee(t) : [];
  }
  function lo(t, e, n) {
    if (e == null || n) return M(t) || (t = ee(t)), t[Le(t.length - 1)];
    var r = fo(t), o = E(r);
    e = Math.max(Math.min(e, o), 0);
    for (var a = o - 1, _ = 0; _ < e; _++) {
      var s = Le(_, a), f = r[_];
      r[_] = r[s], r[s] = f;
    }
    return r.slice(0, e);
  }
  function ci(t) {
    return lo(t, 1 / 0);
  }
  function ui(t, e, n) {
    var r = 0;
    return e = R(e, n), ut(J(t, function(o, a, _) {
      return {
        value: o,
        index: r++,
        criteria: e(o, a, _)
      };
    }).sort(function(o, a) {
      var _ = o.criteria, s = a.criteria;
      if (_ !== s) {
        if (_ > s || _ === void 0) return 1;
        if (_ < s || s === void 0) return -1;
      }
      return o.index - a.index;
    }), "value");
  }
  function Me(t, e) {
    return function(n, r, o) {
      var a = e ? [
        [],
        []
      ] : {};
      return r = R(r, o), V(n, function(_, s) {
        var f = r(_, s, n);
        t(a, _, f);
      }), a;
    };
  }
  const fi = Me(function(t, e, n) {
    U(t, n) ? t[n].push(e) : t[n] = [
      e
    ];
  }), li = Me(function(t, e, n) {
    t[n] = e;
  }), gi = Me(function(t, e, n) {
    U(t, n) ? t[n]++ : t[n] = 1;
  }), di = Me(function(t, e, n) {
    t[n ? 0 : 1].push(e);
  }, true);
  function pi(t) {
    return t == null ? 0 : M(t) ? t.length : v(t).length;
  }
  function hi(t, e, n) {
    return e in n;
  }
  const go = C(function(t, e) {
    var n = {}, r = e[0];
    if (t == null) return n;
    k(r) ? (e.length > 1 && (r = le(r, e[1])), e = ue(t)) : (r = hi, e = Y(e, false, false), t = Object(t));
    for (var o = 0, a = e.length; o < a; o++) {
      var _ = e[o], s = t[_];
      r(s, _, t) && (n[_] = s);
    }
    return n;
  }), wi = C(function(t, e) {
    var n = e[0], r;
    return k(n) ? (n = it(n), e.length > 1 && (r = e[1])) : (e = J(Y(e, false, false), String), n = function(o, a) {
      return !F(e, a);
    }), go(t, n, r);
  });
  function po(t, e, n) {
    return ce.call(t, 0, Math.max(0, t.length - (e == null || n ? 1 : e)));
  }
  function Be(t, e, n) {
    return t == null || t.length < 1 ? e == null || n ? void 0 : [] : e == null || n ? t[0] : po(t, t.length - e);
  }
  function ye(t, e, n) {
    return ce.call(t, e == null || n ? 1 : e);
  }
  function bi(t, e, n) {
    return t == null || t.length < 1 ? e == null || n ? void 0 : [] : e == null || n ? t[t.length - 1] : ye(t, Math.max(0, t.length - e));
  }
  function mi(t) {
    return Z(t, Boolean);
  }
  function yi(t, e) {
    return Y(t, e, false);
  }
  const ho = C(function(t, e) {
    return e = Y(e, true, true), Z(t, function(n) {
      return !F(e, n);
    });
  }), vi = C(function(t, e) {
    return ho(t, e);
  });
  function We(t, e, n, r) {
    Or(e) || (r = n, n = e, e = false), n != null && (n = R(n, r));
    for (var o = [], a = [], _ = 0, s = E(t); _ < s; _++) {
      var f = t[_], g = n ? n(f, _, t) : f;
      e && !n ? ((!_ || a !== g) && o.push(f), a = g) : n ? F(a, g) || (a.push(g), o.push(f)) : F(o, f) || o.push(f);
    }
    return o;
  }
  const Si = C(function(t) {
    return We(Y(t, true, true));
  });
  function ki(t) {
    for (var e = [], n = arguments.length, r = 0, o = E(t); r < o; r++) {
      var a = t[r];
      if (!F(e, a)) {
        var _;
        for (_ = 1; _ < n && F(arguments[_], a); _++) ;
        _ === n && e.push(a);
      }
    }
    return e;
  }
  function qe(t) {
    for (var e = t && uo(t, E).length || 0, n = Array(e), r = 0; r < e; r++) n[r] = ut(t, r);
    return n;
  }
  const Ai = C(qe);
  function Oi(t, e) {
    for (var n = {}, r = 0, o = E(t); r < o; r++) e ? n[t[r]] = e[r] : n[t[r][0]] = t[r][1];
    return n;
  }
  function Ci(t, e, n) {
    e == null && (e = t || 0, t = 0), n || (n = e < t ? -1 : 1);
    for (var r = Math.max(Math.ceil((e - t) / n), 0), o = Array(r), a = 0; a < r; a++, t += n) o[a] = t;
    return o;
  }
  function Ei(t, e) {
    if (e == null || e < 1) return [];
    for (var n = [], r = 0, o = t.length; r < o; ) n.push(ce.call(t, r, r += e));
    return n;
  }
  function ft(t, e) {
    return t._chain ? b(e).chain() : e;
  }
  function wo(t) {
    return V(Ve(t), function(e) {
      var n = b[e] = t[e];
      b.prototype[e] = function() {
        var r = [
          this._wrapped
        ];
        return G_.apply(r, arguments), ft(this, n.apply(b, r));
      };
    }), b;
  }
  V([
    "pop",
    "push",
    "reverse",
    "shift",
    "sort",
    "splice",
    "unshift"
  ], function(t) {
    var e = Ie[t];
    b.prototype[t] = function() {
      var n = this._wrapped;
      return n != null && (e.apply(n, arguments), (t === "shift" || t === "splice") && n.length === 0 && delete n[0]), ft(this, n);
    };
  });
  V([
    "concat",
    "join",
    "slice"
  ], function(t) {
    var e = Ie[t];
    b.prototype[t] = function() {
      var n = this._wrapped;
      return n != null && (n = e.apply(n, arguments)), ft(this, n);
    };
  });
  const Ri = Object.freeze(Object.defineProperty({
    __proto__: null,
    VERSION: vr,
    after: ei,
    all: Et,
    allKeys: ue,
    any: Rt,
    assign: Oe,
    before: no,
    bind: eo,
    bindAll: Js,
    chain: qs,
    chunk: Ei,
    clone: Rs,
    collect: J,
    compact: mi,
    compose: Zs,
    constant: Pr,
    contains: F,
    countBy: gi,
    create: Es,
    debounce: Gs,
    default: b,
    defaults: Wr,
    defer: Xs,
    delay: to,
    detect: Ue,
    difference: ho,
    drop: ye,
    each: V,
    escape: Ds,
    every: Et,
    extend: Ur,
    extendOwn: Oe,
    filter: Z,
    find: Ue,
    findIndex: ct,
    findKey: ro,
    findLastIndex: ao,
    findWhere: ri,
    first: Be,
    flatten: yi,
    foldl: De,
    foldr: Ct,
    forEach: V,
    functions: Ve,
    get: Kr,
    groupBy: fi,
    has: Is,
    head: Be,
    identity: at,
    include: F,
    includes: F,
    indexBy: li,
    indexOf: io,
    initial: po,
    inject: De,
    intersection: ki,
    invert: Lr,
    invoke: ai,
    isArguments: Ze,
    isArray: X,
    isArrayBuffer: Rr,
    isBoolean: Or,
    isDataView: ke,
    isDate: _s,
    isElement: as,
    isEmpty: ws,
    isEqual: bs,
    isError: is,
    isFinite: ls,
    isFunction: k,
    isMap: vs,
    isMatch: Hr,
    isNaN: xr,
    isNull: os,
    isNumber: Cr,
    isObject: K,
    isRegExp: ss,
    isSet: ks,
    isString: Ge,
    isSymbol: Er,
    isTypedArray: jr,
    isUndefined: Ar,
    isWeakMap: Ss,
    isWeakSet: As,
    iteratee: st,
    keys: v,
    last: bi,
    lastIndexOf: ni,
    map: J,
    mapObject: Ms,
    matcher: _e,
    matches: _e,
    max: uo,
    memoize: Ks,
    methods: Ve,
    min: si,
    mixin: wo,
    negate: it,
    noop: Yr,
    now: se,
    object: Oi,
    omit: wi,
    once: ti,
    pairs: Os,
    partial: te,
    partition: di,
    pick: go,
    pluck: ut,
    property: _t,
    propertyOf: xs,
    random: Le,
    range: Ci,
    reduce: De,
    reduceRight: Ct,
    reject: oi,
    rest: ye,
    restArguments: C,
    result: Ls,
    sample: lo,
    select: Z,
    shuffle: ci,
    size: pi,
    some: Rt,
    sortBy: ui,
    sortedIndex: _o,
    tail: ye,
    take: Be,
    tap: Ts,
    template: Vs,
    templateSettings: $s,
    throttle: Ys,
    times: Ps,
    toArray: fo,
    toPath: Jr,
    transpose: qe,
    unescape: js,
    union: Si,
    uniq: We,
    unique: We,
    uniqueId: Ws,
    unzip: qe,
    values: ee,
    where: _i,
    without: vi,
    wrap: Qs,
    zip: Ai
  }, Symbol.toStringTag, {
    value: "Module"
  }));
  var Tt = wo(Ri);
  Tt._ = Tt;
})();
export {
  __tla,
  Wi as a,
  xi as b,
  Mi as c,
  Di as d,
  Xi as e,
  Ni as f,
  Ui as g,
  Ji as h,
  Ki as i,
  Vi as j,
  zi as k,
  Bi as l,
  Fi as m,
  $i as n,
  Gs as o,
  Pi as p,
  Hi as q,
  qi as r,
  ji as s,
  Li as t,
  Eo as u
};
