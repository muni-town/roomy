import { aU as Ys, u as un } from "./BMAj9zKA.js";
import { p as Hs } from "./Baj-A2iI.js";
import { d as Fs, g as qs, e as Gs, u as st, I as Ws } from "./D7Oepc1u.js";
import { l as cs, b as ds, d as Ks, r as Xs, e as Js, g as En, f as Qs, s as ea, c as us, h as Sn, j as ta, k as ra, m as na, n as Hn, o as sa, p as aa, q as ia, t as oa, __tla as __tla_0 } from "./BUkYaDtB.js";
let yt, He;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  const ls = typeof Buffer == "function";
  typeof TextDecoder == "function" && new TextDecoder();
  typeof TextEncoder == "function" && new TextEncoder();
  const fa = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", vr = Array.prototype.slice.call(fa);
  ((r) => {
    let e = {};
    return r.forEach((t, n) => e[t] = n), e;
  })(vr);
  const ca = String.fromCharCode.bind(String);
  typeof Uint8Array.from == "function" && Uint8Array.from.bind(Uint8Array);
  const da = (r) => r.replace(/=/g, "").replace(/[+\/]/g, (e) => e == "+" ? "-" : "_"), ua = (r) => {
    let e, t, n, a, i = "";
    const u = r.length % 3;
    for (let l = 0; l < r.length; ) {
      if ((t = r.charCodeAt(l++)) > 255 || (n = r.charCodeAt(l++)) > 255 || (a = r.charCodeAt(l++)) > 255) throw new TypeError("invalid character found");
      e = t << 16 | n << 8 | a, i += vr[e >> 18 & 63] + vr[e >> 12 & 63] + vr[e >> 6 & 63] + vr[e & 63];
    }
    return u ? i.slice(0, u - 3) + "===".substring(u) : i;
  }, la = typeof btoa == "function" ? (r) => btoa(r) : ls ? (r) => Buffer.from(r, "binary").toString("base64") : ua, Fn = ls ? (r) => Buffer.from(r).toString("base64") : (r) => {
    let t = [];
    for (let n = 0, a = r.length; n < a; n += 4096) t.push(ca.apply(null, r.subarray(n, n + 4096)));
    return la(t.join(""));
  }, ha = (r, e = false) => e ? da(Fn(r)) : Fn(r);
  function xa(r) {
    const e = hs(r);
    return e.enableTextV2 = true, ds(e);
  }
  function pa(r, e) {
    const t = hs(e);
    return t.enableTextV2 = true, t.patchCallback ? cs(ds(t), r) : Ks(r, t);
  }
  function hs(r) {
    return {
      actor: r
    };
  }
  function mr(r, ...e) {
    return {
      load(t) {
        return r.load([
          ...e,
          ...t
        ]);
      },
      async loadRange(t) {
        return (await r.loadRange([
          ...e,
          ...t
        ])).map((a) => ({
          key: a.key.slice(e.length),
          data: a.data
        }));
      },
      remove(t) {
        return r.remove([
          ...e,
          ...t
        ]);
      },
      removeRange(t) {
        return r.removeRange([
          ...e,
          ...t
        ]);
      },
      save(t, n) {
        return r.save([
          ...e,
          ...t
        ], n);
      }
    };
  }
  yt = class {
    agent;
    additionalDids;
    additionalAgents = Promise.resolve({});
    static async buildKey(e) {
      if (e.some((a) => a.includes("\0"))) throw "Cannot encode paths containing null bytes";
      const t = new Uint8Array(new TextEncoder().encode(e.join("\0"))), n = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(t)));
      return ha(n, true);
    }
    constructor(e, ...t) {
      this.agent = e, this.additionalDids = t, this.additionalAgents = (async () => {
        const n = {};
        for (const a of t) {
          const i = await Xs(a);
          if (!i) throw `Could not resolve DID doc for ${a}`;
          const u = (i.service || []).find((l) => l.id === "#atproto_pds");
          if (!u || typeof u.serviceEndpoint != "string") throw `Could not resolve PDS service for ${a}`;
          n[a] = new Fs.Agent(u.serviceEndpoint);
        }
        return n;
      })();
    }
    static async *listRecords(e, t, n) {
      let a;
      do {
        const i = await e.com.atproto.repo.listRecords({
          collection: "chat.roomy.v1.store",
          repo: t,
          cursor: a,
          limit: 100
        });
        if (!i.success) throw `Error listing records from PDS: ${i}`;
        a = i.data.cursor;
        for (const u of i.data.records) {
          const l = u.value;
          let x = true;
          for (let p = 0; p < n.length; p++) if (n[p] != l.key[p]) {
            x = false;
            break;
          }
          x && (yield {
            blobCid: l.data.ref.toString(),
            key: l.key,
            did: t
          });
        }
      } while (a);
    }
    async load(e) {
      const t = await this.agent.com.atproto.repo.getRecord({
        collection: "chat.roomy.v1.store",
        repo: this.agent.assertDid,
        rkey: await yt.buildKey(e)
      });
      if (!t.success) return;
      const n = await this.agent.com.atproto.sync.getBlob({
        cid: t.data.ref.toString(),
        did: this.agent.assertDid
      });
      if (n.success) return n.data;
    }
    async save(e, t) {
      const n = await this.agent.uploadBlob(t);
      if (!n.success) throw `Error uploading blob to PDS ( \`${e}\` ): ${n}`;
      if (!(await this.agent.com.atproto.repo.putRecord({
        collection: "chat.roomy.v1.store",
        repo: this.agent.assertDid,
        rkey: await yt.buildKey(e),
        record: {
          key: e,
          data: n.data.blob
        }
      })).success) throw `Error putting store record to PDS: ${n}`;
    }
    async remove(e) {
      const t = await this.agent.com.atproto.repo.deleteRecord({
        collection: "chat.roomy.v1.store",
        repo: this.agent.assertDid,
        rkey: await yt.buildKey(e)
      });
      if (!t.success) throw `Error deleting record from PDS ( \`${e}\` ): ${t}`;
    }
    async loadRange(e) {
      const t = [];
      for (const n of [
        this.agent.assertDid,
        ...this.additionalDids
      ]) {
        const a = n == this.agent.assertDid ? this.agent : (await this.additionalAgents)[n];
        for await (const i of yt.listRecords(a, n, e)) {
          const u = await a.com.atproto.sync.getBlob({
            cid: i.blobCid,
            did: n
          });
          u.success || console.warn("Error downloading blob", u), t.push({
            key: i.key,
            data: u.success ? new Uint8Array(u.data.buffer) : void 0
          });
        }
      }
      return t;
    }
    async removeRange(e) {
      for await (const t of yt.listRecords(this.agent, this.agent.assertDid, e)) if (t.did == this.agent.assertDid) {
        const n = await this.agent.com.atproto.repo.deleteRecord({
          repo: this.agent.assertDid,
          collection: "chat.roomy.v1.store",
          rkey: await yt.buildKey(t.key)
        });
        n.success || console.warn("Error deleting record", n.data);
      }
    }
  };
  function ga(r) {
    return r > 64 && r < 91 ? r - 65 : r > 96 && r < 123 ? r - 71 : r > 47 && r < 58 ? r + 4 : r === 43 ? 62 : r === 47 ? 63 : 0;
  }
  function ya(r, e) {
    const t = r.replace(/[^A-Za-z0-9+/]/g, ""), n = t.length, a = e ? Math.ceil((n * 3 + 1 >> 2) / e) * e : n * 3 + 1 >> 2, i = new Uint8Array(a);
    let u, l, x = 0, p = 0;
    for (let g = 0; g < n; g++) if (l = g & 3, x |= ga(t.charCodeAt(g)) << 6 * (3 - l), l === 3 || n - g === 1) {
      for (u = 0; u < 3 && p < a; ) i[p] = x >>> (16 >>> u & 24) & 255, u++, p++;
      x = 0;
    }
    return i;
  }
  function ma(r) {
    let e = atob(r), t = e.length, n = new Uint8Array(t);
    for (let a = 0; a < t; a++) n[a] = e.charCodeAt(a);
    return n;
  }
  const Mn = typeof atob == "function" ? ma : ya, va = Mn("hW9KgzjSqVIAiQECBGluaXQQd5D41AGHQhuGDhr51HVZoAGs/tAOrbrldko7PS/zxy9t9bCjgZJ10mjeVUTST27L3wcBAwMDEwIjCUADQwJWAgcVDCEDIwI0AUIDVgKAAQJ+AAF+AQACAX7io+q8BozdOX4AAX8AAgd+A2RtcwZzcGFjZXN+AAECAQJ+AAICAAIAAQ=="), ba = Mn("hW9KgwYD4rcAmAEBBGluaXQBDGJBSOp7Mwq9tlEZt6xK3eWRDtFF2cb5X+EqGKwG+qYGAQIDAhMCIwZAAlYCBxUsIQIjBjQBQgZWBoABAn8AfwF/BX+54YW9Bn8Afwd7C2Rlc2NyaXB0aW9uCG1lc3NhZ2VzBG5hbWUHdGhyZWFkcwh0aW1lbGluZQUAewIBfgMBBXsBAAEAAn0GAAYCAAUAAA=="), _a = Mn("hW9Kg99//uwAgQICEGB1CQqVREfTkD3OSlrqJD4EaW5pdAHe1K/LDPMniEGXeuqmSLltJN3EdaafpeJ98Mpeun9sNAcBAwMDEwMjCUADQwJWAgcVYCEIIww0AUIMVg2AAQJ+AQB+AQB+CAJ+5LCkvQaYzCR+AAF/AAIHdgZhZG1pbnMJYXZhdGFyVXJsCmNhdGVnb3JpZXMIY2hhbm5lbHMLZGVzY3JpcHRpb24IbWVzc2FnZXMKbW9kZXJhdG9ycwRuYW1lDHNpZGViYXJJdGVtcwd0aHJlYWRzfwAFAX8AAwF/CgJ9eX8Fegd9f3wKfgIBAgB6AQACAQIAfgAGAgB/BgIAfwYCAAoAAQ==");
  var Ae;
  (function(r) {
    r.assertEqual = (a) => a;
    function e(a) {
    }
    r.assertIs = e;
    function t(a) {
      throw new Error();
    }
    r.assertNever = t, r.arrayToEnum = (a) => {
      const i = {};
      for (const u of a) i[u] = u;
      return i;
    }, r.getValidEnumValues = (a) => {
      const i = r.objectKeys(a).filter((l) => typeof a[a[l]] != "number"), u = {};
      for (const l of i) u[l] = a[l];
      return r.objectValues(u);
    }, r.objectValues = (a) => r.objectKeys(a).map(function(i) {
      return a[i];
    }), r.objectKeys = typeof Object.keys == "function" ? (a) => Object.keys(a) : (a) => {
      const i = [];
      for (const u in a) Object.prototype.hasOwnProperty.call(a, u) && i.push(u);
      return i;
    }, r.find = (a, i) => {
      for (const u of a) if (i(u)) return u;
    }, r.isInteger = typeof Number.isInteger == "function" ? (a) => Number.isInteger(a) : (a) => typeof a == "number" && isFinite(a) && Math.floor(a) === a;
    function n(a, i = " | ") {
      return a.map((u) => typeof u == "string" ? `'${u}'` : u).join(i);
    }
    r.joinValues = n, r.jsonStringifyReplacer = (a, i) => typeof i == "bigint" ? i.toString() : i;
  })(Ae || (Ae = {}));
  var Tn;
  (function(r) {
    r.mergeShapes = (e, t) => ({
      ...e,
      ...t
    });
  })(Tn || (Tn = {}));
  const M = Ae.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set"
  ]), It = (r) => {
    switch (typeof r) {
      case "undefined":
        return M.undefined;
      case "string":
        return M.string;
      case "number":
        return isNaN(r) ? M.nan : M.number;
      case "boolean":
        return M.boolean;
      case "function":
        return M.function;
      case "bigint":
        return M.bigint;
      case "symbol":
        return M.symbol;
      case "object":
        return Array.isArray(r) ? M.array : r === null ? M.null : r.then && typeof r.then == "function" && r.catch && typeof r.catch == "function" ? M.promise : typeof Map < "u" && r instanceof Map ? M.map : typeof Set < "u" && r instanceof Set ? M.set : typeof Date < "u" && r instanceof Date ? M.date : M.object;
      default:
        return M.unknown;
    }
  }, T = Ae.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite"
  ]), wa = (r) => JSON.stringify(r, null, 2).replace(/"([^"]+)":/g, "$1:");
  class ft extends Error {
    get errors() {
      return this.issues;
    }
    constructor(e) {
      super(), this.issues = [], this.addIssue = (n) => {
        this.issues = [
          ...this.issues,
          n
        ];
      }, this.addIssues = (n = []) => {
        this.issues = [
          ...this.issues,
          ...n
        ];
      };
      const t = new.target.prototype;
      Object.setPrototypeOf ? Object.setPrototypeOf(this, t) : this.__proto__ = t, this.name = "ZodError", this.issues = e;
    }
    format(e) {
      const t = e || function(i) {
        return i.message;
      }, n = {
        _errors: []
      }, a = (i) => {
        for (const u of i.issues) if (u.code === "invalid_union") u.unionErrors.map(a);
        else if (u.code === "invalid_return_type") a(u.returnTypeError);
        else if (u.code === "invalid_arguments") a(u.argumentsError);
        else if (u.path.length === 0) n._errors.push(t(u));
        else {
          let l = n, x = 0;
          for (; x < u.path.length; ) {
            const p = u.path[x];
            x === u.path.length - 1 ? (l[p] = l[p] || {
              _errors: []
            }, l[p]._errors.push(t(u))) : l[p] = l[p] || {
              _errors: []
            }, l = l[p], x++;
          }
        }
      };
      return a(this), n;
    }
    static assert(e) {
      if (!(e instanceof ft)) throw new Error(`Not a ZodError: ${e}`);
    }
    toString() {
      return this.message;
    }
    get message() {
      return JSON.stringify(this.issues, Ae.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
      return this.issues.length === 0;
    }
    flatten(e = (t) => t.message) {
      const t = {}, n = [];
      for (const a of this.issues) a.path.length > 0 ? (t[a.path[0]] = t[a.path[0]] || [], t[a.path[0]].push(e(a))) : n.push(e(a));
      return {
        formErrors: n,
        fieldErrors: t
      };
    }
    get formErrors() {
      return this.flatten();
    }
  }
  ft.create = (r) => new ft(r);
  const fr = (r, e) => {
    let t;
    switch (r.code) {
      case T.invalid_type:
        r.received === M.undefined ? t = "Required" : t = `Expected ${r.expected}, received ${r.received}`;
        break;
      case T.invalid_literal:
        t = `Invalid literal value, expected ${JSON.stringify(r.expected, Ae.jsonStringifyReplacer)}`;
        break;
      case T.unrecognized_keys:
        t = `Unrecognized key(s) in object: ${Ae.joinValues(r.keys, ", ")}`;
        break;
      case T.invalid_union:
        t = "Invalid input";
        break;
      case T.invalid_union_discriminator:
        t = `Invalid discriminator value. Expected ${Ae.joinValues(r.options)}`;
        break;
      case T.invalid_enum_value:
        t = `Invalid enum value. Expected ${Ae.joinValues(r.options)}, received '${r.received}'`;
        break;
      case T.invalid_arguments:
        t = "Invalid function arguments";
        break;
      case T.invalid_return_type:
        t = "Invalid function return type";
        break;
      case T.invalid_date:
        t = "Invalid date";
        break;
      case T.invalid_string:
        typeof r.validation == "object" ? "includes" in r.validation ? (t = `Invalid input: must include "${r.validation.includes}"`, typeof r.validation.position == "number" && (t = `${t} at one or more positions greater than or equal to ${r.validation.position}`)) : "startsWith" in r.validation ? t = `Invalid input: must start with "${r.validation.startsWith}"` : "endsWith" in r.validation ? t = `Invalid input: must end with "${r.validation.endsWith}"` : Ae.assertNever(r.validation) : r.validation !== "regex" ? t = `Invalid ${r.validation}` : t = "Invalid";
        break;
      case T.too_small:
        r.type === "array" ? t = `Array must contain ${r.exact ? "exactly" : r.inclusive ? "at least" : "more than"} ${r.minimum} element(s)` : r.type === "string" ? t = `String must contain ${r.exact ? "exactly" : r.inclusive ? "at least" : "over"} ${r.minimum} character(s)` : r.type === "number" ? t = `Number must be ${r.exact ? "exactly equal to " : r.inclusive ? "greater than or equal to " : "greater than "}${r.minimum}` : r.type === "date" ? t = `Date must be ${r.exact ? "exactly equal to " : r.inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(r.minimum))}` : t = "Invalid input";
        break;
      case T.too_big:
        r.type === "array" ? t = `Array must contain ${r.exact ? "exactly" : r.inclusive ? "at most" : "less than"} ${r.maximum} element(s)` : r.type === "string" ? t = `String must contain ${r.exact ? "exactly" : r.inclusive ? "at most" : "under"} ${r.maximum} character(s)` : r.type === "number" ? t = `Number must be ${r.exact ? "exactly" : r.inclusive ? "less than or equal to" : "less than"} ${r.maximum}` : r.type === "bigint" ? t = `BigInt must be ${r.exact ? "exactly" : r.inclusive ? "less than or equal to" : "less than"} ${r.maximum}` : r.type === "date" ? t = `Date must be ${r.exact ? "exactly" : r.inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(r.maximum))}` : t = "Invalid input";
        break;
      case T.custom:
        t = "Invalid input";
        break;
      case T.invalid_intersection_types:
        t = "Intersection results could not be merged";
        break;
      case T.not_multiple_of:
        t = `Number must be a multiple of ${r.multipleOf}`;
        break;
      case T.not_finite:
        t = "Number must be finite";
        break;
      default:
        t = e.defaultError, Ae.assertNever(r);
    }
    return {
      message: t
    };
  };
  let xs = fr;
  function Aa(r) {
    xs = r;
  }
  function Gr() {
    return xs;
  }
  const Wr = (r) => {
    const { data: e, path: t, errorMaps: n, issueData: a } = r, i = [
      ...t,
      ...a.path || []
    ], u = {
      ...a,
      path: i
    };
    if (a.message !== void 0) return {
      ...a,
      path: i,
      message: a.message
    };
    let l = "";
    const x = n.filter((p) => !!p).slice().reverse();
    for (const p of x) l = p(u, {
      data: e,
      defaultError: l
    }).message;
    return {
      ...a,
      path: i,
      message: l
    };
  }, Ea = [];
  function C(r, e) {
    const t = Gr(), n = Wr({
      issueData: e,
      data: r.data,
      path: r.path,
      errorMaps: [
        r.common.contextualErrorMap,
        r.schemaErrorMap,
        t,
        t === fr ? void 0 : fr
      ].filter((a) => !!a)
    });
    r.common.issues.push(n);
  }
  class tt {
    constructor() {
      this.value = "valid";
    }
    dirty() {
      this.value === "valid" && (this.value = "dirty");
    }
    abort() {
      this.value !== "aborted" && (this.value = "aborted");
    }
    static mergeArray(e, t) {
      const n = [];
      for (const a of t) {
        if (a.status === "aborted") return X;
        a.status === "dirty" && e.dirty(), n.push(a.value);
      }
      return {
        status: e.value,
        value: n
      };
    }
    static async mergeObjectAsync(e, t) {
      const n = [];
      for (const a of t) {
        const i = await a.key, u = await a.value;
        n.push({
          key: i,
          value: u
        });
      }
      return tt.mergeObjectSync(e, n);
    }
    static mergeObjectSync(e, t) {
      const n = {};
      for (const a of t) {
        const { key: i, value: u } = a;
        if (i.status === "aborted" || u.status === "aborted") return X;
        i.status === "dirty" && e.dirty(), u.status === "dirty" && e.dirty(), i.value !== "__proto__" && (typeof u.value < "u" || a.alwaysSet) && (n[i.value] = u.value);
      }
      return {
        status: e.value,
        value: n
      };
    }
  }
  const X = Object.freeze({
    status: "aborted"
  }), nr = (r) => ({
    status: "dirty",
    value: r
  }), nt = (r) => ({
    status: "valid",
    value: r
  }), kn = (r) => r.status === "aborted", Bn = (r) => r.status === "dirty", Ft = (r) => r.status === "valid", wr = (r) => typeof Promise < "u" && r instanceof Promise;
  function Kr(r, e, t, n) {
    if (typeof e == "function" ? r !== e || true : !e.has(r)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return e.get(r);
  }
  function ps(r, e, t, n, a) {
    if (typeof e == "function" ? r !== e || true : !e.has(r)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return e.set(r, t), t;
  }
  var P;
  (function(r) {
    r.errToObj = (e) => typeof e == "string" ? {
      message: e
    } : e || {}, r.toString = (e) => typeof e == "string" ? e : e?.message;
  })(P || (P = {}));
  var br, _r;
  class At {
    constructor(e, t, n, a) {
      this._cachedPath = [], this.parent = e, this.data = t, this._path = n, this._key = a;
    }
    get path() {
      return this._cachedPath.length || (this._key instanceof Array ? this._cachedPath.push(...this._path, ...this._key) : this._cachedPath.push(...this._path, this._key)), this._cachedPath;
    }
  }
  const qn = (r, e) => {
    if (Ft(e)) return {
      success: true,
      data: e.value
    };
    if (!r.common.issues.length) throw new Error("Validation failed but no issues detected.");
    return {
      success: false,
      get error() {
        if (this._error) return this._error;
        const t = new ft(r.common.issues);
        return this._error = t, this._error;
      }
    };
  };
  function oe(r) {
    if (!r) return {};
    const { errorMap: e, invalid_type_error: t, required_error: n, description: a } = r;
    if (e && (t || n)) throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    return e ? {
      errorMap: e,
      description: a
    } : {
      errorMap: (u, l) => {
        var x, p;
        const { message: g } = r;
        return u.code === "invalid_enum_value" ? {
          message: g ?? l.defaultError
        } : typeof l.data > "u" ? {
          message: (x = g ?? n) !== null && x !== void 0 ? x : l.defaultError
        } : u.code !== "invalid_type" ? {
          message: l.defaultError
        } : {
          message: (p = g ?? t) !== null && p !== void 0 ? p : l.defaultError
        };
      },
      description: a
    };
  }
  class he {
    get description() {
      return this._def.description;
    }
    _getType(e) {
      return It(e.data);
    }
    _getOrReturnCtx(e, t) {
      return t || {
        common: e.parent.common,
        data: e.data,
        parsedType: It(e.data),
        schemaErrorMap: this._def.errorMap,
        path: e.path,
        parent: e.parent
      };
    }
    _processInputParams(e) {
      return {
        status: new tt(),
        ctx: {
          common: e.parent.common,
          data: e.data,
          parsedType: It(e.data),
          schemaErrorMap: this._def.errorMap,
          path: e.path,
          parent: e.parent
        }
      };
    }
    _parseSync(e) {
      const t = this._parse(e);
      if (wr(t)) throw new Error("Synchronous parse encountered promise.");
      return t;
    }
    _parseAsync(e) {
      const t = this._parse(e);
      return Promise.resolve(t);
    }
    parse(e, t) {
      const n = this.safeParse(e, t);
      if (n.success) return n.data;
      throw n.error;
    }
    safeParse(e, t) {
      var n;
      const a = {
        common: {
          issues: [],
          async: (n = t?.async) !== null && n !== void 0 ? n : false,
          contextualErrorMap: t?.errorMap
        },
        path: t?.path || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data: e,
        parsedType: It(e)
      }, i = this._parseSync({
        data: e,
        path: a.path,
        parent: a
      });
      return qn(a, i);
    }
    "~validate"(e) {
      var t, n;
      const a = {
        common: {
          issues: [],
          async: !!this["~standard"].async
        },
        path: [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data: e,
        parsedType: It(e)
      };
      if (!this["~standard"].async) try {
        const i = this._parseSync({
          data: e,
          path: [],
          parent: a
        });
        return Ft(i) ? {
          value: i.value
        } : {
          issues: a.common.issues
        };
      } catch (i) {
        !((n = (t = i?.message) === null || t === void 0 ? void 0 : t.toLowerCase()) === null || n === void 0) && n.includes("encountered") && (this["~standard"].async = true), a.common = {
          issues: [],
          async: true
        };
      }
      return this._parseAsync({
        data: e,
        path: [],
        parent: a
      }).then((i) => Ft(i) ? {
        value: i.value
      } : {
        issues: a.common.issues
      });
    }
    async parseAsync(e, t) {
      const n = await this.safeParseAsync(e, t);
      if (n.success) return n.data;
      throw n.error;
    }
    async safeParseAsync(e, t) {
      const n = {
        common: {
          issues: [],
          contextualErrorMap: t?.errorMap,
          async: true
        },
        path: t?.path || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data: e,
        parsedType: It(e)
      }, a = this._parse({
        data: e,
        path: n.path,
        parent: n
      }), i = await (wr(a) ? a : Promise.resolve(a));
      return qn(n, i);
    }
    refine(e, t) {
      const n = (a) => typeof t == "string" || typeof t > "u" ? {
        message: t
      } : typeof t == "function" ? t(a) : t;
      return this._refinement((a, i) => {
        const u = e(a), l = () => i.addIssue({
          code: T.custom,
          ...n(a)
        });
        return typeof Promise < "u" && u instanceof Promise ? u.then((x) => x ? true : (l(), false)) : u ? true : (l(), false);
      });
    }
    refinement(e, t) {
      return this._refinement((n, a) => e(n) ? true : (a.addIssue(typeof t == "function" ? t(n, a) : t), false));
    }
    _refinement(e) {
      return new bt({
        schema: this,
        typeName: K.ZodEffects,
        effect: {
          type: "refinement",
          refinement: e
        }
      });
    }
    superRefine(e) {
      return this._refinement(e);
    }
    constructor(e) {
      this.spa = this.safeParseAsync, this._def = e, this.parse = this.parse.bind(this), this.safeParse = this.safeParse.bind(this), this.parseAsync = this.parseAsync.bind(this), this.safeParseAsync = this.safeParseAsync.bind(this), this.spa = this.spa.bind(this), this.refine = this.refine.bind(this), this.refinement = this.refinement.bind(this), this.superRefine = this.superRefine.bind(this), this.optional = this.optional.bind(this), this.nullable = this.nullable.bind(this), this.nullish = this.nullish.bind(this), this.array = this.array.bind(this), this.promise = this.promise.bind(this), this.or = this.or.bind(this), this.and = this.and.bind(this), this.transform = this.transform.bind(this), this.brand = this.brand.bind(this), this.default = this.default.bind(this), this.catch = this.catch.bind(this), this.describe = this.describe.bind(this), this.pipe = this.pipe.bind(this), this.readonly = this.readonly.bind(this), this.isNullable = this.isNullable.bind(this), this.isOptional = this.isOptional.bind(this), this["~standard"] = {
        version: 1,
        vendor: "zod",
        validate: (t) => this["~validate"](t)
      };
    }
    optional() {
      return wt.create(this, this._def);
    }
    nullable() {
      return Ut.create(this, this._def);
    }
    nullish() {
      return this.nullable().optional();
    }
    array() {
      return vt.create(this);
    }
    promise() {
      return dr.create(this, this._def);
    }
    or(e) {
      return Tr.create([
        this,
        e
      ], this._def);
    }
    and(e) {
      return kr.create(this, e, this._def);
    }
    transform(e) {
      return new bt({
        ...oe(this._def),
        schema: this,
        typeName: K.ZodEffects,
        effect: {
          type: "transform",
          transform: e
        }
      });
    }
    default(e) {
      const t = typeof e == "function" ? e : () => e;
      return new Nr({
        ...oe(this._def),
        innerType: this,
        defaultValue: t,
        typeName: K.ZodDefault
      });
    }
    brand() {
      return new Un({
        typeName: K.ZodBranded,
        type: this,
        ...oe(this._def)
      });
    }
    catch(e) {
      const t = typeof e == "function" ? e : () => e;
      return new Rr({
        ...oe(this._def),
        innerType: this,
        catchValue: t,
        typeName: K.ZodCatch
      });
    }
    describe(e) {
      const t = this.constructor;
      return new t({
        ...this._def,
        description: e
      });
    }
    pipe(e) {
      return Ur.create(this, e);
    }
    readonly() {
      return Or.create(this);
    }
    isOptional() {
      return this.safeParse(void 0).success;
    }
    isNullable() {
      return this.safeParse(null).success;
    }
  }
  const Sa = /^c[^\s-]{8,}$/i, Ta = /^[0-9a-z]+$/, ka = /^[0-9A-HJKMNP-TV-Z]{26}$/i, Ba = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i, Ia = /^[a-z0-9_-]{21}$/i, Ca = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/, Za = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/, Na = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i, Ra = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
  let ln;
  const Oa = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/, Ma = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/, Ua = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/, ja = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/, La = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/, Da = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/, gs = "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))", za = new RegExp(`^${gs}$`);
  function ys(r) {
    let e = "([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d";
    return r.precision ? e = `${e}\\.\\d{${r.precision}}` : r.precision == null && (e = `${e}(\\.\\d+)?`), e;
  }
  function $a(r) {
    return new RegExp(`^${ys(r)}$`);
  }
  function ms(r) {
    let e = `${gs}T${ys(r)}`;
    const t = [];
    return t.push(r.local ? "Z?" : "Z"), r.offset && t.push("([+-]\\d{2}:?\\d{2})"), e = `${e}(${t.join("|")})`, new RegExp(`^${e}$`);
  }
  function Va(r, e) {
    return !!((e === "v4" || !e) && Oa.test(r) || (e === "v6" || !e) && Ua.test(r));
  }
  function Pa(r, e) {
    if (!Ca.test(r)) return false;
    try {
      const [t] = r.split("."), n = t.replace(/-/g, "+").replace(/_/g, "/").padEnd(t.length + (4 - t.length % 4) % 4, "="), a = JSON.parse(atob(n));
      return !(typeof a != "object" || a === null || !a.typ || !a.alg || e && a.alg !== e);
    } catch {
      return false;
    }
  }
  function Ya(r, e) {
    return !!((e === "v4" || !e) && Ma.test(r) || (e === "v6" || !e) && ja.test(r));
  }
  class mt extends he {
    _parse(e) {
      if (this._def.coerce && (e.data = String(e.data)), this._getType(e) !== M.string) {
        const i = this._getOrReturnCtx(e);
        return C(i, {
          code: T.invalid_type,
          expected: M.string,
          received: i.parsedType
        }), X;
      }
      const n = new tt();
      let a;
      for (const i of this._def.checks) if (i.kind === "min") e.data.length < i.value && (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.too_small,
        minimum: i.value,
        type: "string",
        inclusive: true,
        exact: false,
        message: i.message
      }), n.dirty());
      else if (i.kind === "max") e.data.length > i.value && (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.too_big,
        maximum: i.value,
        type: "string",
        inclusive: true,
        exact: false,
        message: i.message
      }), n.dirty());
      else if (i.kind === "length") {
        const u = e.data.length > i.value, l = e.data.length < i.value;
        (u || l) && (a = this._getOrReturnCtx(e, a), u ? C(a, {
          code: T.too_big,
          maximum: i.value,
          type: "string",
          inclusive: true,
          exact: true,
          message: i.message
        }) : l && C(a, {
          code: T.too_small,
          minimum: i.value,
          type: "string",
          inclusive: true,
          exact: true,
          message: i.message
        }), n.dirty());
      } else if (i.kind === "email") Na.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "email",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "emoji") ln || (ln = new RegExp(Ra, "u")), ln.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "emoji",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "uuid") Ba.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "uuid",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "nanoid") Ia.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "nanoid",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "cuid") Sa.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "cuid",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "cuid2") Ta.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "cuid2",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "ulid") ka.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "ulid",
        code: T.invalid_string,
        message: i.message
      }), n.dirty());
      else if (i.kind === "url") try {
        new URL(e.data);
      } catch {
        a = this._getOrReturnCtx(e, a), C(a, {
          validation: "url",
          code: T.invalid_string,
          message: i.message
        }), n.dirty();
      }
      else i.kind === "regex" ? (i.regex.lastIndex = 0, i.regex.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "regex",
        code: T.invalid_string,
        message: i.message
      }), n.dirty())) : i.kind === "trim" ? e.data = e.data.trim() : i.kind === "includes" ? e.data.includes(i.value, i.position) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: {
          includes: i.value,
          position: i.position
        },
        message: i.message
      }), n.dirty()) : i.kind === "toLowerCase" ? e.data = e.data.toLowerCase() : i.kind === "toUpperCase" ? e.data = e.data.toUpperCase() : i.kind === "startsWith" ? e.data.startsWith(i.value) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: {
          startsWith: i.value
        },
        message: i.message
      }), n.dirty()) : i.kind === "endsWith" ? e.data.endsWith(i.value) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: {
          endsWith: i.value
        },
        message: i.message
      }), n.dirty()) : i.kind === "datetime" ? ms(i).test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: "datetime",
        message: i.message
      }), n.dirty()) : i.kind === "date" ? za.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: "date",
        message: i.message
      }), n.dirty()) : i.kind === "time" ? $a(i).test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.invalid_string,
        validation: "time",
        message: i.message
      }), n.dirty()) : i.kind === "duration" ? Za.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "duration",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : i.kind === "ip" ? Va(e.data, i.version) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "ip",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : i.kind === "jwt" ? Pa(e.data, i.alg) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "jwt",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : i.kind === "cidr" ? Ya(e.data, i.version) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "cidr",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : i.kind === "base64" ? La.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "base64",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : i.kind === "base64url" ? Da.test(e.data) || (a = this._getOrReturnCtx(e, a), C(a, {
        validation: "base64url",
        code: T.invalid_string,
        message: i.message
      }), n.dirty()) : Ae.assertNever(i);
      return {
        status: n.value,
        value: e.data
      };
    }
    _regex(e, t, n) {
      return this.refinement((a) => e.test(a), {
        validation: t,
        code: T.invalid_string,
        ...P.errToObj(n)
      });
    }
    _addCheck(e) {
      return new mt({
        ...this._def,
        checks: [
          ...this._def.checks,
          e
        ]
      });
    }
    email(e) {
      return this._addCheck({
        kind: "email",
        ...P.errToObj(e)
      });
    }
    url(e) {
      return this._addCheck({
        kind: "url",
        ...P.errToObj(e)
      });
    }
    emoji(e) {
      return this._addCheck({
        kind: "emoji",
        ...P.errToObj(e)
      });
    }
    uuid(e) {
      return this._addCheck({
        kind: "uuid",
        ...P.errToObj(e)
      });
    }
    nanoid(e) {
      return this._addCheck({
        kind: "nanoid",
        ...P.errToObj(e)
      });
    }
    cuid(e) {
      return this._addCheck({
        kind: "cuid",
        ...P.errToObj(e)
      });
    }
    cuid2(e) {
      return this._addCheck({
        kind: "cuid2",
        ...P.errToObj(e)
      });
    }
    ulid(e) {
      return this._addCheck({
        kind: "ulid",
        ...P.errToObj(e)
      });
    }
    base64(e) {
      return this._addCheck({
        kind: "base64",
        ...P.errToObj(e)
      });
    }
    base64url(e) {
      return this._addCheck({
        kind: "base64url",
        ...P.errToObj(e)
      });
    }
    jwt(e) {
      return this._addCheck({
        kind: "jwt",
        ...P.errToObj(e)
      });
    }
    ip(e) {
      return this._addCheck({
        kind: "ip",
        ...P.errToObj(e)
      });
    }
    cidr(e) {
      return this._addCheck({
        kind: "cidr",
        ...P.errToObj(e)
      });
    }
    datetime(e) {
      var t, n;
      return typeof e == "string" ? this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: e
      }) : this._addCheck({
        kind: "datetime",
        precision: typeof e?.precision > "u" ? null : e?.precision,
        offset: (t = e?.offset) !== null && t !== void 0 ? t : false,
        local: (n = e?.local) !== null && n !== void 0 ? n : false,
        ...P.errToObj(e?.message)
      });
    }
    date(e) {
      return this._addCheck({
        kind: "date",
        message: e
      });
    }
    time(e) {
      return typeof e == "string" ? this._addCheck({
        kind: "time",
        precision: null,
        message: e
      }) : this._addCheck({
        kind: "time",
        precision: typeof e?.precision > "u" ? null : e?.precision,
        ...P.errToObj(e?.message)
      });
    }
    duration(e) {
      return this._addCheck({
        kind: "duration",
        ...P.errToObj(e)
      });
    }
    regex(e, t) {
      return this._addCheck({
        kind: "regex",
        regex: e,
        ...P.errToObj(t)
      });
    }
    includes(e, t) {
      return this._addCheck({
        kind: "includes",
        value: e,
        position: t?.position,
        ...P.errToObj(t?.message)
      });
    }
    startsWith(e, t) {
      return this._addCheck({
        kind: "startsWith",
        value: e,
        ...P.errToObj(t)
      });
    }
    endsWith(e, t) {
      return this._addCheck({
        kind: "endsWith",
        value: e,
        ...P.errToObj(t)
      });
    }
    min(e, t) {
      return this._addCheck({
        kind: "min",
        value: e,
        ...P.errToObj(t)
      });
    }
    max(e, t) {
      return this._addCheck({
        kind: "max",
        value: e,
        ...P.errToObj(t)
      });
    }
    length(e, t) {
      return this._addCheck({
        kind: "length",
        value: e,
        ...P.errToObj(t)
      });
    }
    nonempty(e) {
      return this.min(1, P.errToObj(e));
    }
    trim() {
      return new mt({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind: "trim"
          }
        ]
      });
    }
    toLowerCase() {
      return new mt({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind: "toLowerCase"
          }
        ]
      });
    }
    toUpperCase() {
      return new mt({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind: "toUpperCase"
          }
        ]
      });
    }
    get isDatetime() {
      return !!this._def.checks.find((e) => e.kind === "datetime");
    }
    get isDate() {
      return !!this._def.checks.find((e) => e.kind === "date");
    }
    get isTime() {
      return !!this._def.checks.find((e) => e.kind === "time");
    }
    get isDuration() {
      return !!this._def.checks.find((e) => e.kind === "duration");
    }
    get isEmail() {
      return !!this._def.checks.find((e) => e.kind === "email");
    }
    get isURL() {
      return !!this._def.checks.find((e) => e.kind === "url");
    }
    get isEmoji() {
      return !!this._def.checks.find((e) => e.kind === "emoji");
    }
    get isUUID() {
      return !!this._def.checks.find((e) => e.kind === "uuid");
    }
    get isNANOID() {
      return !!this._def.checks.find((e) => e.kind === "nanoid");
    }
    get isCUID() {
      return !!this._def.checks.find((e) => e.kind === "cuid");
    }
    get isCUID2() {
      return !!this._def.checks.find((e) => e.kind === "cuid2");
    }
    get isULID() {
      return !!this._def.checks.find((e) => e.kind === "ulid");
    }
    get isIP() {
      return !!this._def.checks.find((e) => e.kind === "ip");
    }
    get isCIDR() {
      return !!this._def.checks.find((e) => e.kind === "cidr");
    }
    get isBase64() {
      return !!this._def.checks.find((e) => e.kind === "base64");
    }
    get isBase64url() {
      return !!this._def.checks.find((e) => e.kind === "base64url");
    }
    get minLength() {
      let e = null;
      for (const t of this._def.checks) t.kind === "min" && (e === null || t.value > e) && (e = t.value);
      return e;
    }
    get maxLength() {
      let e = null;
      for (const t of this._def.checks) t.kind === "max" && (e === null || t.value < e) && (e = t.value);
      return e;
    }
  }
  mt.create = (r) => {
    var e;
    return new mt({
      checks: [],
      typeName: K.ZodString,
      coerce: (e = r?.coerce) !== null && e !== void 0 ? e : false,
      ...oe(r)
    });
  };
  function Ha(r, e) {
    const t = (r.toString().split(".")[1] || "").length, n = (e.toString().split(".")[1] || "").length, a = t > n ? t : n, i = parseInt(r.toFixed(a).replace(".", "")), u = parseInt(e.toFixed(a).replace(".", ""));
    return i % u / Math.pow(10, a);
  }
  class Rt extends he {
    constructor() {
      super(...arguments), this.min = this.gte, this.max = this.lte, this.step = this.multipleOf;
    }
    _parse(e) {
      if (this._def.coerce && (e.data = Number(e.data)), this._getType(e) !== M.number) {
        const i = this._getOrReturnCtx(e);
        return C(i, {
          code: T.invalid_type,
          expected: M.number,
          received: i.parsedType
        }), X;
      }
      let n;
      const a = new tt();
      for (const i of this._def.checks) i.kind === "int" ? Ae.isInteger(e.data) || (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.invalid_type,
        expected: "integer",
        received: "float",
        message: i.message
      }), a.dirty()) : i.kind === "min" ? (i.inclusive ? e.data < i.value : e.data <= i.value) && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.too_small,
        minimum: i.value,
        type: "number",
        inclusive: i.inclusive,
        exact: false,
        message: i.message
      }), a.dirty()) : i.kind === "max" ? (i.inclusive ? e.data > i.value : e.data >= i.value) && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.too_big,
        maximum: i.value,
        type: "number",
        inclusive: i.inclusive,
        exact: false,
        message: i.message
      }), a.dirty()) : i.kind === "multipleOf" ? Ha(e.data, i.value) !== 0 && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.not_multiple_of,
        multipleOf: i.value,
        message: i.message
      }), a.dirty()) : i.kind === "finite" ? Number.isFinite(e.data) || (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.not_finite,
        message: i.message
      }), a.dirty()) : Ae.assertNever(i);
      return {
        status: a.value,
        value: e.data
      };
    }
    gte(e, t) {
      return this.setLimit("min", e, true, P.toString(t));
    }
    gt(e, t) {
      return this.setLimit("min", e, false, P.toString(t));
    }
    lte(e, t) {
      return this.setLimit("max", e, true, P.toString(t));
    }
    lt(e, t) {
      return this.setLimit("max", e, false, P.toString(t));
    }
    setLimit(e, t, n, a) {
      return new Rt({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind: e,
            value: t,
            inclusive: n,
            message: P.toString(a)
          }
        ]
      });
    }
    _addCheck(e) {
      return new Rt({
        ...this._def,
        checks: [
          ...this._def.checks,
          e
        ]
      });
    }
    int(e) {
      return this._addCheck({
        kind: "int",
        message: P.toString(e)
      });
    }
    positive(e) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: false,
        message: P.toString(e)
      });
    }
    negative(e) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: false,
        message: P.toString(e)
      });
    }
    nonpositive(e) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: true,
        message: P.toString(e)
      });
    }
    nonnegative(e) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: true,
        message: P.toString(e)
      });
    }
    multipleOf(e, t) {
      return this._addCheck({
        kind: "multipleOf",
        value: e,
        message: P.toString(t)
      });
    }
    finite(e) {
      return this._addCheck({
        kind: "finite",
        message: P.toString(e)
      });
    }
    safe(e) {
      return this._addCheck({
        kind: "min",
        inclusive: true,
        value: Number.MIN_SAFE_INTEGER,
        message: P.toString(e)
      })._addCheck({
        kind: "max",
        inclusive: true,
        value: Number.MAX_SAFE_INTEGER,
        message: P.toString(e)
      });
    }
    get minValue() {
      let e = null;
      for (const t of this._def.checks) t.kind === "min" && (e === null || t.value > e) && (e = t.value);
      return e;
    }
    get maxValue() {
      let e = null;
      for (const t of this._def.checks) t.kind === "max" && (e === null || t.value < e) && (e = t.value);
      return e;
    }
    get isInt() {
      return !!this._def.checks.find((e) => e.kind === "int" || e.kind === "multipleOf" && Ae.isInteger(e.value));
    }
    get isFinite() {
      let e = null, t = null;
      for (const n of this._def.checks) {
        if (n.kind === "finite" || n.kind === "int" || n.kind === "multipleOf") return true;
        n.kind === "min" ? (t === null || n.value > t) && (t = n.value) : n.kind === "max" && (e === null || n.value < e) && (e = n.value);
      }
      return Number.isFinite(t) && Number.isFinite(e);
    }
  }
  Rt.create = (r) => new Rt({
    checks: [],
    typeName: K.ZodNumber,
    coerce: r?.coerce || false,
    ...oe(r)
  });
  class Ot extends he {
    constructor() {
      super(...arguments), this.min = this.gte, this.max = this.lte;
    }
    _parse(e) {
      if (this._def.coerce) try {
        e.data = BigInt(e.data);
      } catch {
        return this._getInvalidInput(e);
      }
      if (this._getType(e) !== M.bigint) return this._getInvalidInput(e);
      let n;
      const a = new tt();
      for (const i of this._def.checks) i.kind === "min" ? (i.inclusive ? e.data < i.value : e.data <= i.value) && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.too_small,
        type: "bigint",
        minimum: i.value,
        inclusive: i.inclusive,
        message: i.message
      }), a.dirty()) : i.kind === "max" ? (i.inclusive ? e.data > i.value : e.data >= i.value) && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.too_big,
        type: "bigint",
        maximum: i.value,
        inclusive: i.inclusive,
        message: i.message
      }), a.dirty()) : i.kind === "multipleOf" ? e.data % i.value !== BigInt(0) && (n = this._getOrReturnCtx(e, n), C(n, {
        code: T.not_multiple_of,
        multipleOf: i.value,
        message: i.message
      }), a.dirty()) : Ae.assertNever(i);
      return {
        status: a.value,
        value: e.data
      };
    }
    _getInvalidInput(e) {
      const t = this._getOrReturnCtx(e);
      return C(t, {
        code: T.invalid_type,
        expected: M.bigint,
        received: t.parsedType
      }), X;
    }
    gte(e, t) {
      return this.setLimit("min", e, true, P.toString(t));
    }
    gt(e, t) {
      return this.setLimit("min", e, false, P.toString(t));
    }
    lte(e, t) {
      return this.setLimit("max", e, true, P.toString(t));
    }
    lt(e, t) {
      return this.setLimit("max", e, false, P.toString(t));
    }
    setLimit(e, t, n, a) {
      return new Ot({
        ...this._def,
        checks: [
          ...this._def.checks,
          {
            kind: e,
            value: t,
            inclusive: n,
            message: P.toString(a)
          }
        ]
      });
    }
    _addCheck(e) {
      return new Ot({
        ...this._def,
        checks: [
          ...this._def.checks,
          e
        ]
      });
    }
    positive(e) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: false,
        message: P.toString(e)
      });
    }
    negative(e) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: false,
        message: P.toString(e)
      });
    }
    nonpositive(e) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: true,
        message: P.toString(e)
      });
    }
    nonnegative(e) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: true,
        message: P.toString(e)
      });
    }
    multipleOf(e, t) {
      return this._addCheck({
        kind: "multipleOf",
        value: e,
        message: P.toString(t)
      });
    }
    get minValue() {
      let e = null;
      for (const t of this._def.checks) t.kind === "min" && (e === null || t.value > e) && (e = t.value);
      return e;
    }
    get maxValue() {
      let e = null;
      for (const t of this._def.checks) t.kind === "max" && (e === null || t.value < e) && (e = t.value);
      return e;
    }
  }
  Ot.create = (r) => {
    var e;
    return new Ot({
      checks: [],
      typeName: K.ZodBigInt,
      coerce: (e = r?.coerce) !== null && e !== void 0 ? e : false,
      ...oe(r)
    });
  };
  class Ar extends he {
    _parse(e) {
      if (this._def.coerce && (e.data = !!e.data), this._getType(e) !== M.boolean) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.boolean,
          received: n.parsedType
        }), X;
      }
      return nt(e.data);
    }
  }
  Ar.create = (r) => new Ar({
    typeName: K.ZodBoolean,
    coerce: r?.coerce || false,
    ...oe(r)
  });
  class qt extends he {
    _parse(e) {
      if (this._def.coerce && (e.data = new Date(e.data)), this._getType(e) !== M.date) {
        const i = this._getOrReturnCtx(e);
        return C(i, {
          code: T.invalid_type,
          expected: M.date,
          received: i.parsedType
        }), X;
      }
      if (isNaN(e.data.getTime())) {
        const i = this._getOrReturnCtx(e);
        return C(i, {
          code: T.invalid_date
        }), X;
      }
      const n = new tt();
      let a;
      for (const i of this._def.checks) i.kind === "min" ? e.data.getTime() < i.value && (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.too_small,
        message: i.message,
        inclusive: true,
        exact: false,
        minimum: i.value,
        type: "date"
      }), n.dirty()) : i.kind === "max" ? e.data.getTime() > i.value && (a = this._getOrReturnCtx(e, a), C(a, {
        code: T.too_big,
        message: i.message,
        inclusive: true,
        exact: false,
        maximum: i.value,
        type: "date"
      }), n.dirty()) : Ae.assertNever(i);
      return {
        status: n.value,
        value: new Date(e.data.getTime())
      };
    }
    _addCheck(e) {
      return new qt({
        ...this._def,
        checks: [
          ...this._def.checks,
          e
        ]
      });
    }
    min(e, t) {
      return this._addCheck({
        kind: "min",
        value: e.getTime(),
        message: P.toString(t)
      });
    }
    max(e, t) {
      return this._addCheck({
        kind: "max",
        value: e.getTime(),
        message: P.toString(t)
      });
    }
    get minDate() {
      let e = null;
      for (const t of this._def.checks) t.kind === "min" && (e === null || t.value > e) && (e = t.value);
      return e != null ? new Date(e) : null;
    }
    get maxDate() {
      let e = null;
      for (const t of this._def.checks) t.kind === "max" && (e === null || t.value < e) && (e = t.value);
      return e != null ? new Date(e) : null;
    }
  }
  qt.create = (r) => new qt({
    checks: [],
    coerce: r?.coerce || false,
    typeName: K.ZodDate,
    ...oe(r)
  });
  class Xr extends he {
    _parse(e) {
      if (this._getType(e) !== M.symbol) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.symbol,
          received: n.parsedType
        }), X;
      }
      return nt(e.data);
    }
  }
  Xr.create = (r) => new Xr({
    typeName: K.ZodSymbol,
    ...oe(r)
  });
  class Er extends he {
    _parse(e) {
      if (this._getType(e) !== M.undefined) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.undefined,
          received: n.parsedType
        }), X;
      }
      return nt(e.data);
    }
  }
  Er.create = (r) => new Er({
    typeName: K.ZodUndefined,
    ...oe(r)
  });
  class Sr extends he {
    _parse(e) {
      if (this._getType(e) !== M.null) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.null,
          received: n.parsedType
        }), X;
      }
      return nt(e.data);
    }
  }
  Sr.create = (r) => new Sr({
    typeName: K.ZodNull,
    ...oe(r)
  });
  class cr extends he {
    constructor() {
      super(...arguments), this._any = true;
    }
    _parse(e) {
      return nt(e.data);
    }
  }
  cr.create = (r) => new cr({
    typeName: K.ZodAny,
    ...oe(r)
  });
  class Ht extends he {
    constructor() {
      super(...arguments), this._unknown = true;
    }
    _parse(e) {
      return nt(e.data);
    }
  }
  Ht.create = (r) => new Ht({
    typeName: K.ZodUnknown,
    ...oe(r)
  });
  class Ct extends he {
    _parse(e) {
      const t = this._getOrReturnCtx(e);
      return C(t, {
        code: T.invalid_type,
        expected: M.never,
        received: t.parsedType
      }), X;
    }
  }
  Ct.create = (r) => new Ct({
    typeName: K.ZodNever,
    ...oe(r)
  });
  class Jr extends he {
    _parse(e) {
      if (this._getType(e) !== M.undefined) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.void,
          received: n.parsedType
        }), X;
      }
      return nt(e.data);
    }
  }
  Jr.create = (r) => new Jr({
    typeName: K.ZodVoid,
    ...oe(r)
  });
  class vt extends he {
    _parse(e) {
      const { ctx: t, status: n } = this._processInputParams(e), a = this._def;
      if (t.parsedType !== M.array) return C(t, {
        code: T.invalid_type,
        expected: M.array,
        received: t.parsedType
      }), X;
      if (a.exactLength !== null) {
        const u = t.data.length > a.exactLength.value, l = t.data.length < a.exactLength.value;
        (u || l) && (C(t, {
          code: u ? T.too_big : T.too_small,
          minimum: l ? a.exactLength.value : void 0,
          maximum: u ? a.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: a.exactLength.message
        }), n.dirty());
      }
      if (a.minLength !== null && t.data.length < a.minLength.value && (C(t, {
        code: T.too_small,
        minimum: a.minLength.value,
        type: "array",
        inclusive: true,
        exact: false,
        message: a.minLength.message
      }), n.dirty()), a.maxLength !== null && t.data.length > a.maxLength.value && (C(t, {
        code: T.too_big,
        maximum: a.maxLength.value,
        type: "array",
        inclusive: true,
        exact: false,
        message: a.maxLength.message
      }), n.dirty()), t.common.async) return Promise.all([
        ...t.data
      ].map((u, l) => a.type._parseAsync(new At(t, u, t.path, l)))).then((u) => tt.mergeArray(n, u));
      const i = [
        ...t.data
      ].map((u, l) => a.type._parseSync(new At(t, u, t.path, l)));
      return tt.mergeArray(n, i);
    }
    get element() {
      return this._def.type;
    }
    min(e, t) {
      return new vt({
        ...this._def,
        minLength: {
          value: e,
          message: P.toString(t)
        }
      });
    }
    max(e, t) {
      return new vt({
        ...this._def,
        maxLength: {
          value: e,
          message: P.toString(t)
        }
      });
    }
    length(e, t) {
      return new vt({
        ...this._def,
        exactLength: {
          value: e,
          message: P.toString(t)
        }
      });
    }
    nonempty(e) {
      return this.min(1, e);
    }
  }
  vt.create = (r, e) => new vt({
    type: r,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: K.ZodArray,
    ...oe(e)
  });
  function rr(r) {
    if (r instanceof je) {
      const e = {};
      for (const t in r.shape) {
        const n = r.shape[t];
        e[t] = wt.create(rr(n));
      }
      return new je({
        ...r._def,
        shape: () => e
      });
    } else return r instanceof vt ? new vt({
      ...r._def,
      type: rr(r.element)
    }) : r instanceof wt ? wt.create(rr(r.unwrap())) : r instanceof Ut ? Ut.create(rr(r.unwrap())) : r instanceof Et ? Et.create(r.items.map((e) => rr(e))) : r;
  }
  class je extends he {
    constructor() {
      super(...arguments), this._cached = null, this.nonstrict = this.passthrough, this.augment = this.extend;
    }
    _getCached() {
      if (this._cached !== null) return this._cached;
      const e = this._def.shape(), t = Ae.objectKeys(e);
      return this._cached = {
        shape: e,
        keys: t
      };
    }
    _parse(e) {
      if (this._getType(e) !== M.object) {
        const p = this._getOrReturnCtx(e);
        return C(p, {
          code: T.invalid_type,
          expected: M.object,
          received: p.parsedType
        }), X;
      }
      const { status: n, ctx: a } = this._processInputParams(e), { shape: i, keys: u } = this._getCached(), l = [];
      if (!(this._def.catchall instanceof Ct && this._def.unknownKeys === "strip")) for (const p in a.data) u.includes(p) || l.push(p);
      const x = [];
      for (const p of u) {
        const g = i[p], I = a.data[p];
        x.push({
          key: {
            status: "valid",
            value: p
          },
          value: g._parse(new At(a, I, a.path, p)),
          alwaysSet: p in a.data
        });
      }
      if (this._def.catchall instanceof Ct) {
        const p = this._def.unknownKeys;
        if (p === "passthrough") for (const g of l) x.push({
          key: {
            status: "valid",
            value: g
          },
          value: {
            status: "valid",
            value: a.data[g]
          }
        });
        else if (p === "strict") l.length > 0 && (C(a, {
          code: T.unrecognized_keys,
          keys: l
        }), n.dirty());
        else if (p !== "strip") throw new Error("Internal ZodObject error: invalid unknownKeys value.");
      } else {
        const p = this._def.catchall;
        for (const g of l) {
          const I = a.data[g];
          x.push({
            key: {
              status: "valid",
              value: g
            },
            value: p._parse(new At(a, I, a.path, g)),
            alwaysSet: g in a.data
          });
        }
      }
      return a.common.async ? Promise.resolve().then(async () => {
        const p = [];
        for (const g of x) {
          const I = await g.key, Y = await g.value;
          p.push({
            key: I,
            value: Y,
            alwaysSet: g.alwaysSet
          });
        }
        return p;
      }).then((p) => tt.mergeObjectSync(n, p)) : tt.mergeObjectSync(n, x);
    }
    get shape() {
      return this._def.shape();
    }
    strict(e) {
      return P.errToObj, new je({
        ...this._def,
        unknownKeys: "strict",
        ...e !== void 0 ? {
          errorMap: (t, n) => {
            var a, i, u, l;
            const x = (u = (i = (a = this._def).errorMap) === null || i === void 0 ? void 0 : i.call(a, t, n).message) !== null && u !== void 0 ? u : n.defaultError;
            return t.code === "unrecognized_keys" ? {
              message: (l = P.errToObj(e).message) !== null && l !== void 0 ? l : x
            } : {
              message: x
            };
          }
        } : {}
      });
    }
    strip() {
      return new je({
        ...this._def,
        unknownKeys: "strip"
      });
    }
    passthrough() {
      return new je({
        ...this._def,
        unknownKeys: "passthrough"
      });
    }
    extend(e) {
      return new je({
        ...this._def,
        shape: () => ({
          ...this._def.shape(),
          ...e
        })
      });
    }
    merge(e) {
      return new je({
        unknownKeys: e._def.unknownKeys,
        catchall: e._def.catchall,
        shape: () => ({
          ...this._def.shape(),
          ...e._def.shape()
        }),
        typeName: K.ZodObject
      });
    }
    setKey(e, t) {
      return this.augment({
        [e]: t
      });
    }
    catchall(e) {
      return new je({
        ...this._def,
        catchall: e
      });
    }
    pick(e) {
      const t = {};
      return Ae.objectKeys(e).forEach((n) => {
        e[n] && this.shape[n] && (t[n] = this.shape[n]);
      }), new je({
        ...this._def,
        shape: () => t
      });
    }
    omit(e) {
      const t = {};
      return Ae.objectKeys(this.shape).forEach((n) => {
        e[n] || (t[n] = this.shape[n]);
      }), new je({
        ...this._def,
        shape: () => t
      });
    }
    deepPartial() {
      return rr(this);
    }
    partial(e) {
      const t = {};
      return Ae.objectKeys(this.shape).forEach((n) => {
        const a = this.shape[n];
        e && !e[n] ? t[n] = a : t[n] = a.optional();
      }), new je({
        ...this._def,
        shape: () => t
      });
    }
    required(e) {
      const t = {};
      return Ae.objectKeys(this.shape).forEach((n) => {
        if (e && !e[n]) t[n] = this.shape[n];
        else {
          let i = this.shape[n];
          for (; i instanceof wt; ) i = i._def.innerType;
          t[n] = i;
        }
      }), new je({
        ...this._def,
        shape: () => t
      });
    }
    keyof() {
      return vs(Ae.objectKeys(this.shape));
    }
  }
  je.create = (r, e) => new je({
    shape: () => r,
    unknownKeys: "strip",
    catchall: Ct.create(),
    typeName: K.ZodObject,
    ...oe(e)
  });
  je.strictCreate = (r, e) => new je({
    shape: () => r,
    unknownKeys: "strict",
    catchall: Ct.create(),
    typeName: K.ZodObject,
    ...oe(e)
  });
  je.lazycreate = (r, e) => new je({
    shape: r,
    unknownKeys: "strip",
    catchall: Ct.create(),
    typeName: K.ZodObject,
    ...oe(e)
  });
  class Tr extends he {
    _parse(e) {
      const { ctx: t } = this._processInputParams(e), n = this._def.options;
      function a(i) {
        for (const l of i) if (l.result.status === "valid") return l.result;
        for (const l of i) if (l.result.status === "dirty") return t.common.issues.push(...l.ctx.common.issues), l.result;
        const u = i.map((l) => new ft(l.ctx.common.issues));
        return C(t, {
          code: T.invalid_union,
          unionErrors: u
        }), X;
      }
      if (t.common.async) return Promise.all(n.map(async (i) => {
        const u = {
          ...t,
          common: {
            ...t.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await i._parseAsync({
            data: t.data,
            path: t.path,
            parent: u
          }),
          ctx: u
        };
      })).then(a);
      {
        let i;
        const u = [];
        for (const x of n) {
          const p = {
            ...t,
            common: {
              ...t.common,
              issues: []
            },
            parent: null
          }, g = x._parseSync({
            data: t.data,
            path: t.path,
            parent: p
          });
          if (g.status === "valid") return g;
          g.status === "dirty" && !i && (i = {
            result: g,
            ctx: p
          }), p.common.issues.length && u.push(p.common.issues);
        }
        if (i) return t.common.issues.push(...i.ctx.common.issues), i.result;
        const l = u.map((x) => new ft(x));
        return C(t, {
          code: T.invalid_union,
          unionErrors: l
        }), X;
      }
    }
    get options() {
      return this._def.options;
    }
  }
  Tr.create = (r, e) => new Tr({
    options: r,
    typeName: K.ZodUnion,
    ...oe(e)
  });
  const Bt = (r) => r instanceof Ir ? Bt(r.schema) : r instanceof bt ? Bt(r.innerType()) : r instanceof Cr ? [
    r.value
  ] : r instanceof Mt ? r.options : r instanceof Zr ? Ae.objectValues(r.enum) : r instanceof Nr ? Bt(r._def.innerType) : r instanceof Er ? [
    void 0
  ] : r instanceof Sr ? [
    null
  ] : r instanceof wt ? [
    void 0,
    ...Bt(r.unwrap())
  ] : r instanceof Ut ? [
    null,
    ...Bt(r.unwrap())
  ] : r instanceof Un || r instanceof Or ? Bt(r.unwrap()) : r instanceof Rr ? Bt(r._def.innerType) : [];
  class rn extends he {
    _parse(e) {
      const { ctx: t } = this._processInputParams(e);
      if (t.parsedType !== M.object) return C(t, {
        code: T.invalid_type,
        expected: M.object,
        received: t.parsedType
      }), X;
      const n = this.discriminator, a = t.data[n], i = this.optionsMap.get(a);
      return i ? t.common.async ? i._parseAsync({
        data: t.data,
        path: t.path,
        parent: t
      }) : i._parseSync({
        data: t.data,
        path: t.path,
        parent: t
      }) : (C(t, {
        code: T.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [
          n
        ]
      }), X);
    }
    get discriminator() {
      return this._def.discriminator;
    }
    get options() {
      return this._def.options;
    }
    get optionsMap() {
      return this._def.optionsMap;
    }
    static create(e, t, n) {
      const a = /* @__PURE__ */ new Map();
      for (const i of t) {
        const u = Bt(i.shape[e]);
        if (!u.length) throw new Error(`A discriminator value for key \`${e}\` could not be extracted from all schema options`);
        for (const l of u) {
          if (a.has(l)) throw new Error(`Discriminator property ${String(e)} has duplicate value ${String(l)}`);
          a.set(l, i);
        }
      }
      return new rn({
        typeName: K.ZodDiscriminatedUnion,
        discriminator: e,
        options: t,
        optionsMap: a,
        ...oe(n)
      });
    }
  }
  function In(r, e) {
    const t = It(r), n = It(e);
    if (r === e) return {
      valid: true,
      data: r
    };
    if (t === M.object && n === M.object) {
      const a = Ae.objectKeys(e), i = Ae.objectKeys(r).filter((l) => a.indexOf(l) !== -1), u = {
        ...r,
        ...e
      };
      for (const l of i) {
        const x = In(r[l], e[l]);
        if (!x.valid) return {
          valid: false
        };
        u[l] = x.data;
      }
      return {
        valid: true,
        data: u
      };
    } else if (t === M.array && n === M.array) {
      if (r.length !== e.length) return {
        valid: false
      };
      const a = [];
      for (let i = 0; i < r.length; i++) {
        const u = r[i], l = e[i], x = In(u, l);
        if (!x.valid) return {
          valid: false
        };
        a.push(x.data);
      }
      return {
        valid: true,
        data: a
      };
    } else return t === M.date && n === M.date && +r == +e ? {
      valid: true,
      data: r
    } : {
      valid: false
    };
  }
  class kr extends he {
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e), a = (i, u) => {
        if (kn(i) || kn(u)) return X;
        const l = In(i.value, u.value);
        return l.valid ? ((Bn(i) || Bn(u)) && t.dirty(), {
          status: t.value,
          value: l.data
        }) : (C(n, {
          code: T.invalid_intersection_types
        }), X);
      };
      return n.common.async ? Promise.all([
        this._def.left._parseAsync({
          data: n.data,
          path: n.path,
          parent: n
        }),
        this._def.right._parseAsync({
          data: n.data,
          path: n.path,
          parent: n
        })
      ]).then(([i, u]) => a(i, u)) : a(this._def.left._parseSync({
        data: n.data,
        path: n.path,
        parent: n
      }), this._def.right._parseSync({
        data: n.data,
        path: n.path,
        parent: n
      }));
    }
  }
  kr.create = (r, e, t) => new kr({
    left: r,
    right: e,
    typeName: K.ZodIntersection,
    ...oe(t)
  });
  class Et extends he {
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== M.array) return C(n, {
        code: T.invalid_type,
        expected: M.array,
        received: n.parsedType
      }), X;
      if (n.data.length < this._def.items.length) return C(n, {
        code: T.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      }), X;
      !this._def.rest && n.data.length > this._def.items.length && (C(n, {
        code: T.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      }), t.dirty());
      const i = [
        ...n.data
      ].map((u, l) => {
        const x = this._def.items[l] || this._def.rest;
        return x ? x._parse(new At(n, u, n.path, l)) : null;
      }).filter((u) => !!u);
      return n.common.async ? Promise.all(i).then((u) => tt.mergeArray(t, u)) : tt.mergeArray(t, i);
    }
    get items() {
      return this._def.items;
    }
    rest(e) {
      return new Et({
        ...this._def,
        rest: e
      });
    }
  }
  Et.create = (r, e) => {
    if (!Array.isArray(r)) throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    return new Et({
      items: r,
      typeName: K.ZodTuple,
      rest: null,
      ...oe(e)
    });
  };
  class Br extends he {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== M.object) return C(n, {
        code: T.invalid_type,
        expected: M.object,
        received: n.parsedType
      }), X;
      const a = [], i = this._def.keyType, u = this._def.valueType;
      for (const l in n.data) a.push({
        key: i._parse(new At(n, l, n.path, l)),
        value: u._parse(new At(n, n.data[l], n.path, l)),
        alwaysSet: l in n.data
      });
      return n.common.async ? tt.mergeObjectAsync(t, a) : tt.mergeObjectSync(t, a);
    }
    get element() {
      return this._def.valueType;
    }
    static create(e, t, n) {
      return t instanceof he ? new Br({
        keyType: e,
        valueType: t,
        typeName: K.ZodRecord,
        ...oe(n)
      }) : new Br({
        keyType: mt.create(),
        valueType: e,
        typeName: K.ZodRecord,
        ...oe(t)
      });
    }
  }
  class Qr extends he {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== M.map) return C(n, {
        code: T.invalid_type,
        expected: M.map,
        received: n.parsedType
      }), X;
      const a = this._def.keyType, i = this._def.valueType, u = [
        ...n.data.entries()
      ].map(([l, x], p) => ({
        key: a._parse(new At(n, l, n.path, [
          p,
          "key"
        ])),
        value: i._parse(new At(n, x, n.path, [
          p,
          "value"
        ]))
      }));
      if (n.common.async) {
        const l = /* @__PURE__ */ new Map();
        return Promise.resolve().then(async () => {
          for (const x of u) {
            const p = await x.key, g = await x.value;
            if (p.status === "aborted" || g.status === "aborted") return X;
            (p.status === "dirty" || g.status === "dirty") && t.dirty(), l.set(p.value, g.value);
          }
          return {
            status: t.value,
            value: l
          };
        });
      } else {
        const l = /* @__PURE__ */ new Map();
        for (const x of u) {
          const p = x.key, g = x.value;
          if (p.status === "aborted" || g.status === "aborted") return X;
          (p.status === "dirty" || g.status === "dirty") && t.dirty(), l.set(p.value, g.value);
        }
        return {
          status: t.value,
          value: l
        };
      }
    }
  }
  Qr.create = (r, e, t) => new Qr({
    valueType: e,
    keyType: r,
    typeName: K.ZodMap,
    ...oe(t)
  });
  class Gt extends he {
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== M.set) return C(n, {
        code: T.invalid_type,
        expected: M.set,
        received: n.parsedType
      }), X;
      const a = this._def;
      a.minSize !== null && n.data.size < a.minSize.value && (C(n, {
        code: T.too_small,
        minimum: a.minSize.value,
        type: "set",
        inclusive: true,
        exact: false,
        message: a.minSize.message
      }), t.dirty()), a.maxSize !== null && n.data.size > a.maxSize.value && (C(n, {
        code: T.too_big,
        maximum: a.maxSize.value,
        type: "set",
        inclusive: true,
        exact: false,
        message: a.maxSize.message
      }), t.dirty());
      const i = this._def.valueType;
      function u(x) {
        const p = /* @__PURE__ */ new Set();
        for (const g of x) {
          if (g.status === "aborted") return X;
          g.status === "dirty" && t.dirty(), p.add(g.value);
        }
        return {
          status: t.value,
          value: p
        };
      }
      const l = [
        ...n.data.values()
      ].map((x, p) => i._parse(new At(n, x, n.path, p)));
      return n.common.async ? Promise.all(l).then((x) => u(x)) : u(l);
    }
    min(e, t) {
      return new Gt({
        ...this._def,
        minSize: {
          value: e,
          message: P.toString(t)
        }
      });
    }
    max(e, t) {
      return new Gt({
        ...this._def,
        maxSize: {
          value: e,
          message: P.toString(t)
        }
      });
    }
    size(e, t) {
      return this.min(e, t).max(e, t);
    }
    nonempty(e) {
      return this.min(1, e);
    }
  }
  Gt.create = (r, e) => new Gt({
    valueType: r,
    minSize: null,
    maxSize: null,
    typeName: K.ZodSet,
    ...oe(e)
  });
  class sr extends he {
    constructor() {
      super(...arguments), this.validate = this.implement;
    }
    _parse(e) {
      const { ctx: t } = this._processInputParams(e);
      if (t.parsedType !== M.function) return C(t, {
        code: T.invalid_type,
        expected: M.function,
        received: t.parsedType
      }), X;
      function n(l, x) {
        return Wr({
          data: l,
          path: t.path,
          errorMaps: [
            t.common.contextualErrorMap,
            t.schemaErrorMap,
            Gr(),
            fr
          ].filter((p) => !!p),
          issueData: {
            code: T.invalid_arguments,
            argumentsError: x
          }
        });
      }
      function a(l, x) {
        return Wr({
          data: l,
          path: t.path,
          errorMaps: [
            t.common.contextualErrorMap,
            t.schemaErrorMap,
            Gr(),
            fr
          ].filter((p) => !!p),
          issueData: {
            code: T.invalid_return_type,
            returnTypeError: x
          }
        });
      }
      const i = {
        errorMap: t.common.contextualErrorMap
      }, u = t.data;
      if (this._def.returns instanceof dr) {
        const l = this;
        return nt(async function(...x) {
          const p = new ft([]), g = await l._def.args.parseAsync(x, i).catch((F) => {
            throw p.addIssue(n(x, F)), p;
          }), I = await Reflect.apply(u, this, g);
          return await l._def.returns._def.type.parseAsync(I, i).catch((F) => {
            throw p.addIssue(a(I, F)), p;
          });
        });
      } else {
        const l = this;
        return nt(function(...x) {
          const p = l._def.args.safeParse(x, i);
          if (!p.success) throw new ft([
            n(x, p.error)
          ]);
          const g = Reflect.apply(u, this, p.data), I = l._def.returns.safeParse(g, i);
          if (!I.success) throw new ft([
            a(g, I.error)
          ]);
          return I.data;
        });
      }
    }
    parameters() {
      return this._def.args;
    }
    returnType() {
      return this._def.returns;
    }
    args(...e) {
      return new sr({
        ...this._def,
        args: Et.create(e).rest(Ht.create())
      });
    }
    returns(e) {
      return new sr({
        ...this._def,
        returns: e
      });
    }
    implement(e) {
      return this.parse(e);
    }
    strictImplement(e) {
      return this.parse(e);
    }
    static create(e, t, n) {
      return new sr({
        args: e || Et.create([]).rest(Ht.create()),
        returns: t || Ht.create(),
        typeName: K.ZodFunction,
        ...oe(n)
      });
    }
  }
  class Ir extends he {
    get schema() {
      return this._def.getter();
    }
    _parse(e) {
      const { ctx: t } = this._processInputParams(e);
      return this._def.getter()._parse({
        data: t.data,
        path: t.path,
        parent: t
      });
    }
  }
  Ir.create = (r, e) => new Ir({
    getter: r,
    typeName: K.ZodLazy,
    ...oe(e)
  });
  class Cr extends he {
    _parse(e) {
      if (e.data !== this._def.value) {
        const t = this._getOrReturnCtx(e);
        return C(t, {
          received: t.data,
          code: T.invalid_literal,
          expected: this._def.value
        }), X;
      }
      return {
        status: "valid",
        value: e.data
      };
    }
    get value() {
      return this._def.value;
    }
  }
  Cr.create = (r, e) => new Cr({
    value: r,
    typeName: K.ZodLiteral,
    ...oe(e)
  });
  function vs(r, e) {
    return new Mt({
      values: r,
      typeName: K.ZodEnum,
      ...oe(e)
    });
  }
  class Mt extends he {
    constructor() {
      super(...arguments), br.set(this, void 0);
    }
    _parse(e) {
      if (typeof e.data != "string") {
        const t = this._getOrReturnCtx(e), n = this._def.values;
        return C(t, {
          expected: Ae.joinValues(n),
          received: t.parsedType,
          code: T.invalid_type
        }), X;
      }
      if (Kr(this, br) || ps(this, br, new Set(this._def.values)), !Kr(this, br).has(e.data)) {
        const t = this._getOrReturnCtx(e), n = this._def.values;
        return C(t, {
          received: t.data,
          code: T.invalid_enum_value,
          options: n
        }), X;
      }
      return nt(e.data);
    }
    get options() {
      return this._def.values;
    }
    get enum() {
      const e = {};
      for (const t of this._def.values) e[t] = t;
      return e;
    }
    get Values() {
      const e = {};
      for (const t of this._def.values) e[t] = t;
      return e;
    }
    get Enum() {
      const e = {};
      for (const t of this._def.values) e[t] = t;
      return e;
    }
    extract(e, t = this._def) {
      return Mt.create(e, {
        ...this._def,
        ...t
      });
    }
    exclude(e, t = this._def) {
      return Mt.create(this.options.filter((n) => !e.includes(n)), {
        ...this._def,
        ...t
      });
    }
  }
  br = /* @__PURE__ */ new WeakMap();
  Mt.create = vs;
  class Zr extends he {
    constructor() {
      super(...arguments), _r.set(this, void 0);
    }
    _parse(e) {
      const t = Ae.getValidEnumValues(this._def.values), n = this._getOrReturnCtx(e);
      if (n.parsedType !== M.string && n.parsedType !== M.number) {
        const a = Ae.objectValues(t);
        return C(n, {
          expected: Ae.joinValues(a),
          received: n.parsedType,
          code: T.invalid_type
        }), X;
      }
      if (Kr(this, _r) || ps(this, _r, new Set(Ae.getValidEnumValues(this._def.values))), !Kr(this, _r).has(e.data)) {
        const a = Ae.objectValues(t);
        return C(n, {
          received: n.data,
          code: T.invalid_enum_value,
          options: a
        }), X;
      }
      return nt(e.data);
    }
    get enum() {
      return this._def.values;
    }
  }
  _r = /* @__PURE__ */ new WeakMap();
  Zr.create = (r, e) => new Zr({
    values: r,
    typeName: K.ZodNativeEnum,
    ...oe(e)
  });
  class dr extends he {
    unwrap() {
      return this._def.type;
    }
    _parse(e) {
      const { ctx: t } = this._processInputParams(e);
      if (t.parsedType !== M.promise && t.common.async === false) return C(t, {
        code: T.invalid_type,
        expected: M.promise,
        received: t.parsedType
      }), X;
      const n = t.parsedType === M.promise ? t.data : Promise.resolve(t.data);
      return nt(n.then((a) => this._def.type.parseAsync(a, {
        path: t.path,
        errorMap: t.common.contextualErrorMap
      })));
    }
  }
  dr.create = (r, e) => new dr({
    type: r,
    typeName: K.ZodPromise,
    ...oe(e)
  });
  class bt extends he {
    innerType() {
      return this._def.schema;
    }
    sourceType() {
      return this._def.schema._def.typeName === K.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
    }
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e), a = this._def.effect || null, i = {
        addIssue: (u) => {
          C(n, u), u.fatal ? t.abort() : t.dirty();
        },
        get path() {
          return n.path;
        }
      };
      if (i.addIssue = i.addIssue.bind(i), a.type === "preprocess") {
        const u = a.transform(n.data, i);
        if (n.common.async) return Promise.resolve(u).then(async (l) => {
          if (t.value === "aborted") return X;
          const x = await this._def.schema._parseAsync({
            data: l,
            path: n.path,
            parent: n
          });
          return x.status === "aborted" ? X : x.status === "dirty" || t.value === "dirty" ? nr(x.value) : x;
        });
        {
          if (t.value === "aborted") return X;
          const l = this._def.schema._parseSync({
            data: u,
            path: n.path,
            parent: n
          });
          return l.status === "aborted" ? X : l.status === "dirty" || t.value === "dirty" ? nr(l.value) : l;
        }
      }
      if (a.type === "refinement") {
        const u = (l) => {
          const x = a.refinement(l, i);
          if (n.common.async) return Promise.resolve(x);
          if (x instanceof Promise) throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
          return l;
        };
        if (n.common.async === false) {
          const l = this._def.schema._parseSync({
            data: n.data,
            path: n.path,
            parent: n
          });
          return l.status === "aborted" ? X : (l.status === "dirty" && t.dirty(), u(l.value), {
            status: t.value,
            value: l.value
          });
        } else return this._def.schema._parseAsync({
          data: n.data,
          path: n.path,
          parent: n
        }).then((l) => l.status === "aborted" ? X : (l.status === "dirty" && t.dirty(), u(l.value).then(() => ({
          status: t.value,
          value: l.value
        }))));
      }
      if (a.type === "transform") if (n.common.async === false) {
        const u = this._def.schema._parseSync({
          data: n.data,
          path: n.path,
          parent: n
        });
        if (!Ft(u)) return u;
        const l = a.transform(u.value, i);
        if (l instanceof Promise) throw new Error("Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.");
        return {
          status: t.value,
          value: l
        };
      } else return this._def.schema._parseAsync({
        data: n.data,
        path: n.path,
        parent: n
      }).then((u) => Ft(u) ? Promise.resolve(a.transform(u.value, i)).then((l) => ({
        status: t.value,
        value: l
      })) : u);
      Ae.assertNever(a);
    }
  }
  bt.create = (r, e, t) => new bt({
    schema: r,
    typeName: K.ZodEffects,
    effect: e,
    ...oe(t)
  });
  bt.createWithPreprocess = (r, e, t) => new bt({
    schema: e,
    effect: {
      type: "preprocess",
      transform: r
    },
    typeName: K.ZodEffects,
    ...oe(t)
  });
  class wt extends he {
    _parse(e) {
      return this._getType(e) === M.undefined ? nt(void 0) : this._def.innerType._parse(e);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  wt.create = (r, e) => new wt({
    innerType: r,
    typeName: K.ZodOptional,
    ...oe(e)
  });
  class Ut extends he {
    _parse(e) {
      return this._getType(e) === M.null ? nt(null) : this._def.innerType._parse(e);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  Ut.create = (r, e) => new Ut({
    innerType: r,
    typeName: K.ZodNullable,
    ...oe(e)
  });
  class Nr extends he {
    _parse(e) {
      const { ctx: t } = this._processInputParams(e);
      let n = t.data;
      return t.parsedType === M.undefined && (n = this._def.defaultValue()), this._def.innerType._parse({
        data: n,
        path: t.path,
        parent: t
      });
    }
    removeDefault() {
      return this._def.innerType;
    }
  }
  Nr.create = (r, e) => new Nr({
    innerType: r,
    typeName: K.ZodDefault,
    defaultValue: typeof e.default == "function" ? e.default : () => e.default,
    ...oe(e)
  });
  class Rr extends he {
    _parse(e) {
      const { ctx: t } = this._processInputParams(e), n = {
        ...t,
        common: {
          ...t.common,
          issues: []
        }
      }, a = this._def.innerType._parse({
        data: n.data,
        path: n.path,
        parent: {
          ...n
        }
      });
      return wr(a) ? a.then((i) => ({
        status: "valid",
        value: i.status === "valid" ? i.value : this._def.catchValue({
          get error() {
            return new ft(n.common.issues);
          },
          input: n.data
        })
      })) : {
        status: "valid",
        value: a.status === "valid" ? a.value : this._def.catchValue({
          get error() {
            return new ft(n.common.issues);
          },
          input: n.data
        })
      };
    }
    removeCatch() {
      return this._def.innerType;
    }
  }
  Rr.create = (r, e) => new Rr({
    innerType: r,
    typeName: K.ZodCatch,
    catchValue: typeof e.catch == "function" ? e.catch : () => e.catch,
    ...oe(e)
  });
  class en extends he {
    _parse(e) {
      if (this._getType(e) !== M.nan) {
        const n = this._getOrReturnCtx(e);
        return C(n, {
          code: T.invalid_type,
          expected: M.nan,
          received: n.parsedType
        }), X;
      }
      return {
        status: "valid",
        value: e.data
      };
    }
  }
  en.create = (r) => new en({
    typeName: K.ZodNaN,
    ...oe(r)
  });
  const Fa = Symbol("zod_brand");
  class Un extends he {
    _parse(e) {
      const { ctx: t } = this._processInputParams(e), n = t.data;
      return this._def.type._parse({
        data: n,
        path: t.path,
        parent: t
      });
    }
    unwrap() {
      return this._def.type;
    }
  }
  class Ur extends he {
    _parse(e) {
      const { status: t, ctx: n } = this._processInputParams(e);
      if (n.common.async) return (async () => {
        const i = await this._def.in._parseAsync({
          data: n.data,
          path: n.path,
          parent: n
        });
        return i.status === "aborted" ? X : i.status === "dirty" ? (t.dirty(), nr(i.value)) : this._def.out._parseAsync({
          data: i.value,
          path: n.path,
          parent: n
        });
      })();
      {
        const a = this._def.in._parseSync({
          data: n.data,
          path: n.path,
          parent: n
        });
        return a.status === "aborted" ? X : a.status === "dirty" ? (t.dirty(), {
          status: "dirty",
          value: a.value
        }) : this._def.out._parseSync({
          data: a.value,
          path: n.path,
          parent: n
        });
      }
    }
    static create(e, t) {
      return new Ur({
        in: e,
        out: t,
        typeName: K.ZodPipeline
      });
    }
  }
  class Or extends he {
    _parse(e) {
      const t = this._def.innerType._parse(e), n = (a) => (Ft(a) && (a.value = Object.freeze(a.value)), a);
      return wr(t) ? t.then((a) => n(a)) : n(t);
    }
    unwrap() {
      return this._def.innerType;
    }
  }
  Or.create = (r, e) => new Or({
    innerType: r,
    typeName: K.ZodReadonly,
    ...oe(e)
  });
  function Gn(r, e) {
    const t = typeof r == "function" ? r(e) : typeof r == "string" ? {
      message: r
    } : r;
    return typeof t == "string" ? {
      message: t
    } : t;
  }
  function bs(r, e = {}, t) {
    return r ? cr.create().superRefine((n, a) => {
      var i, u;
      const l = r(n);
      if (l instanceof Promise) return l.then((x) => {
        var p, g;
        if (!x) {
          const I = Gn(e, n), Y = (g = (p = I.fatal) !== null && p !== void 0 ? p : t) !== null && g !== void 0 ? g : true;
          a.addIssue({
            code: "custom",
            ...I,
            fatal: Y
          });
        }
      });
      if (!l) {
        const x = Gn(e, n), p = (u = (i = x.fatal) !== null && i !== void 0 ? i : t) !== null && u !== void 0 ? u : true;
        a.addIssue({
          code: "custom",
          ...x,
          fatal: p
        });
      }
    }) : cr.create();
  }
  const qa = {
    object: je.lazycreate
  };
  var K;
  (function(r) {
    r.ZodString = "ZodString", r.ZodNumber = "ZodNumber", r.ZodNaN = "ZodNaN", r.ZodBigInt = "ZodBigInt", r.ZodBoolean = "ZodBoolean", r.ZodDate = "ZodDate", r.ZodSymbol = "ZodSymbol", r.ZodUndefined = "ZodUndefined", r.ZodNull = "ZodNull", r.ZodAny = "ZodAny", r.ZodUnknown = "ZodUnknown", r.ZodNever = "ZodNever", r.ZodVoid = "ZodVoid", r.ZodArray = "ZodArray", r.ZodObject = "ZodObject", r.ZodUnion = "ZodUnion", r.ZodDiscriminatedUnion = "ZodDiscriminatedUnion", r.ZodIntersection = "ZodIntersection", r.ZodTuple = "ZodTuple", r.ZodRecord = "ZodRecord", r.ZodMap = "ZodMap", r.ZodSet = "ZodSet", r.ZodFunction = "ZodFunction", r.ZodLazy = "ZodLazy", r.ZodLiteral = "ZodLiteral", r.ZodEnum = "ZodEnum", r.ZodEffects = "ZodEffects", r.ZodNativeEnum = "ZodNativeEnum", r.ZodOptional = "ZodOptional", r.ZodNullable = "ZodNullable", r.ZodDefault = "ZodDefault", r.ZodCatch = "ZodCatch", r.ZodPromise = "ZodPromise", r.ZodBranded = "ZodBranded", r.ZodPipeline = "ZodPipeline", r.ZodReadonly = "ZodReadonly";
  })(K || (K = {}));
  const Ga = (r, e = {
    message: `Input not instance of ${r.name}`
  }) => bs((t) => t instanceof r, e), _s = mt.create, ws = Rt.create, Wa = en.create, Ka = Ot.create, As = Ar.create, Xa = qt.create, Ja = Xr.create, Qa = Er.create, ei = Sr.create, ti = cr.create, ri = Ht.create, ni = Ct.create, si = Jr.create, ai = vt.create, ii = je.create, oi = je.strictCreate, fi = Tr.create, ci = rn.create, di = kr.create, ui = Et.create, li = Br.create, hi = Qr.create, xi = Gt.create, pi = sr.create, gi = Ir.create, yi = Cr.create, mi = Mt.create, vi = Zr.create, bi = dr.create, Wn = bt.create, _i = wt.create, wi = Ut.create, Ai = bt.createWithPreprocess, Ei = Ur.create, Si = () => _s().optional(), Ti = () => ws().optional(), ki = () => As().optional(), Bi = {
    string: (r) => mt.create({
      ...r,
      coerce: true
    }),
    number: (r) => Rt.create({
      ...r,
      coerce: true
    }),
    boolean: (r) => Ar.create({
      ...r,
      coerce: true
    }),
    bigint: (r) => Ot.create({
      ...r,
      coerce: true
    }),
    date: (r) => qt.create({
      ...r,
      coerce: true
    })
  }, Ii = X;
  var Re = Object.freeze({
    __proto__: null,
    defaultErrorMap: fr,
    setErrorMap: Aa,
    getErrorMap: Gr,
    makeIssue: Wr,
    EMPTY_PATH: Ea,
    addIssueToContext: C,
    ParseStatus: tt,
    INVALID: X,
    DIRTY: nr,
    OK: nt,
    isAborted: kn,
    isDirty: Bn,
    isValid: Ft,
    isAsync: wr,
    get util() {
      return Ae;
    },
    get objectUtil() {
      return Tn;
    },
    ZodParsedType: M,
    getParsedType: It,
    ZodType: he,
    datetimeRegex: ms,
    ZodString: mt,
    ZodNumber: Rt,
    ZodBigInt: Ot,
    ZodBoolean: Ar,
    ZodDate: qt,
    ZodSymbol: Xr,
    ZodUndefined: Er,
    ZodNull: Sr,
    ZodAny: cr,
    ZodUnknown: Ht,
    ZodNever: Ct,
    ZodVoid: Jr,
    ZodArray: vt,
    ZodObject: je,
    ZodUnion: Tr,
    ZodDiscriminatedUnion: rn,
    ZodIntersection: kr,
    ZodTuple: Et,
    ZodRecord: Br,
    ZodMap: Qr,
    ZodSet: Gt,
    ZodFunction: sr,
    ZodLazy: Ir,
    ZodLiteral: Cr,
    ZodEnum: Mt,
    ZodNativeEnum: Zr,
    ZodPromise: dr,
    ZodEffects: bt,
    ZodTransformer: bt,
    ZodOptional: wt,
    ZodNullable: Ut,
    ZodDefault: Nr,
    ZodCatch: Rr,
    ZodNaN: en,
    BRAND: Fa,
    ZodBranded: Un,
    ZodPipeline: Ur,
    ZodReadonly: Or,
    custom: bs,
    Schema: he,
    ZodSchema: he,
    late: qa,
    get ZodFirstPartyTypeKind() {
      return K;
    },
    coerce: Bi,
    any: ti,
    array: ai,
    bigint: Ka,
    boolean: As,
    date: Xa,
    discriminatedUnion: ci,
    effect: Wn,
    enum: mi,
    function: pi,
    instanceof: Ga,
    intersection: di,
    lazy: gi,
    literal: yi,
    map: hi,
    nan: Wa,
    nativeEnum: vi,
    never: ni,
    null: ei,
    nullable: wi,
    number: ws,
    object: ii,
    oboolean: ki,
    onumber: Ti,
    optional: _i,
    ostring: Si,
    pipeline: Ei,
    preprocess: Ai,
    promise: bi,
    record: li,
    set: xi,
    strictObject: oi,
    string: _s,
    symbol: Ja,
    transformer: Wn,
    tuple: ui,
    undefined: Qa,
    union: fi,
    unknown: ri,
    void: si,
    NEVER: Ii,
    ZodIssueCode: T,
    quotelessJson: wa,
    ZodError: ft
  });
  const Ci = Re.union([
    Re.tuple([
      Re.literal("join"),
      Re.string(),
      Re.string(),
      Re.string()
    ]),
    Re.tuple([
      Re.literal("leave"),
      Re.string(),
      Re.string(),
      Re.string()
    ]),
    Re.tuple([
      Re.literal("send"),
      Re.string(),
      Re.string(),
      Re.string()
    ])
  ]);
  Re.union([
    Re.tuple([
      Re.literal("listen")
    ]).rest(Re.string()),
    Re.tuple([
      Re.literal("send"),
      Re.string(),
      Re.string(),
      Re.string()
    ])
  ]);
  const ar = 4;
  function Zi(r) {
    const e = new DataView(r).getUint32(0, true), t = r.slice(ar, ar + e), n = new TextDecoder().decode(t);
    return {
      header: JSON.parse(n),
      body: new Uint8Array(r.slice(ar + e))
    };
  }
  function hn(r) {
    const e = new TextEncoder().encode(JSON.stringify(r.header)), t = e.length, n = ar + t + r.body.length, a = new Uint8Array(n);
    return new DataView(a.buffer).setUint32(0, t, true), a.set(e, ar), a.set(r.body, ar + t), a.buffer;
  }
  function Ni(r, e) {
    const t = "Error parsing peer message";
    let n;
    try {
      n = Zi(e);
    } catch {
      return new Error(t);
    }
    const a = r.safeParse(n.header);
    return a.error || !a.data ? new Error(`${t}: ${a.error}`) : [
      a.data,
      n.body
    ];
  }
  function Ri(r) {
    return Ni(Ci, r);
  }
  class Oi extends EventTarget {
    dispatchTypedEvent(e, t) {
      return super.dispatchEvent(t);
    }
  }
  function Kn(r, e, t) {
    return r.has(e) || r.set(e, t), r.get(e);
  }
  class Mi extends Event {
    did;
    connId;
    docId;
    constructor(e, t, n) {
      super("join"), this.did = e, this.connId = t, this.docId = n;
    }
  }
  class Ui extends Event {
    did;
    connId;
    docId;
    constructor(e, t, n) {
      super("leave"), this.did = e, this.connId = t, this.docId = n;
    }
  }
  class ji extends Event {
    did;
    connId;
    docId;
    data;
    constructor(e, t, n, a) {
      super("data"), this.did = e, this.connId = t, this.docId = n, this.data = a;
    }
  }
  class Li extends Oi {
    socket;
    open;
    #e = /* @__PURE__ */ new Map();
    get interests() {
      return this.#e;
    }
    constructor(e, t) {
      super(), this.socket = new WebSocket(t, [
        "authorization",
        e
      ]), this.socket.binaryType = "arraybuffer", this.socket.addEventListener("message", (n) => {
        n.data instanceof ArrayBuffer ? this.#t(n.data) : typeof n.data == "string" && this.#t(new TextEncoder().encode(n.data));
      }), this.socket.addEventListener("error", (n) => {
        this.dispatchTypedEvent("error", n);
      }), this.socket.addEventListener("close", () => {
        this.dispatchTypedEvent("close", new Event("close"));
      }), this.open = new Promise((n) => {
        this.socket.addEventListener("open", () => {
          this.dispatchTypedEvent("open", new Event("open")), n();
        });
      });
    }
    removeInterests(...e) {
      for (const t of e) this.#e.has(t) || this.#e.delete(t);
      this.socket.send(hn({
        header: [
          "listen",
          ...this.#e.keys()
        ],
        body: new Uint8Array()
      }));
    }
    addInterests(...e) {
      for (const t of e) this.#e.has(t) || this.#e.set(t, []);
      this.socket.send(hn({
        header: [
          "listen",
          ...this.#e.keys()
        ],
        body: new Uint8Array()
      }));
    }
    send(e, t, n, a) {
      this.socket.send(hn({
        header: [
          "send",
          e,
          t,
          n
        ],
        body: a
      }));
    }
    #t(e) {
      const t = Ri(e);
      if (t instanceof Error) {
        console.warn("Error parsing router message.");
        return;
      }
      const [n, a] = t;
      if (n[0] == "join") {
        const [i, u, l, x] = n;
        Kn(this.#e, x, []).push({
          connId: l,
          did: u
        }), this.dispatchTypedEvent("join", new Mi(u, l, x));
      } else if (n[0] == "leave") {
        const [i, u, l, x] = n, p = Kn(this.#e, x, []);
        this.#e.set(x, p.filter((g) => g.connId !== l || g.did !== u)), this.dispatchTypedEvent("leave", new Ui(u, l, x));
      } else if (n[0] == "send") {
        const [i, u, l, x] = n;
        this.dispatchTypedEvent("data", new ji(u, l, x, a));
      }
    }
  }
  var Es = class extends EventTarget {
    dispatchTypedEvent(r, e) {
      return super.dispatchEvent(e);
    }
  };
  function Di(r) {
    return r instanceof Uint8Array || ArrayBuffer.isView(r) && r.constructor.name === "Uint8Array";
  }
  function Ss(r, ...e) {
    if (!Di(r)) throw new Error("Uint8Array expected");
    if (e.length > 0 && !e.includes(r.length)) throw new Error("Uint8Array expected of length " + e + ", got length=" + r.length);
  }
  function Xn(r, e = true) {
    if (r.destroyed) throw new Error("Hash instance has been destroyed");
    if (e && r.finished) throw new Error("Hash#digest() has already been called");
  }
  function zi(r, e) {
    Ss(r);
    const t = e.outputLen;
    if (r.length < t) throw new Error("digestInto() expects output buffer of length at least " + t);
  }
  const er = typeof globalThis == "object" && "crypto" in globalThis ? globalThis.crypto : void 0;
  function xn(r) {
    return new DataView(r.buffer, r.byteOffset, r.byteLength);
  }
  function $i(r) {
    if (typeof r != "string") throw new Error("utf8ToBytes expected string, got " + typeof r);
    return new Uint8Array(new TextEncoder().encode(r));
  }
  function Ts(r) {
    return typeof r == "string" && (r = $i(r)), Ss(r), r;
  }
  class Vi {
    clone() {
      return this._cloneInto();
    }
  }
  function Pi(r) {
    const e = (n) => r().update(Ts(n)).digest(), t = r();
    return e.outputLen = t.outputLen, e.blockLen = t.blockLen, e.create = () => r(), e;
  }
  function ks(r = 32) {
    if (er && typeof er.getRandomValues == "function") return er.getRandomValues(new Uint8Array(r));
    if (er && typeof er.randomBytes == "function") return er.randomBytes(r);
    throw new Error("crypto.getRandomValues must be defined");
  }
  function Yi(r, e, t, n) {
    if (typeof r.setBigUint64 == "function") return r.setBigUint64(e, t, n);
    const a = BigInt(32), i = BigInt(4294967295), u = Number(t >> a & i), l = Number(t & i), x = n ? 4 : 0, p = n ? 0 : 4;
    r.setUint32(e + x, u, n), r.setUint32(e + p, l, n);
  }
  class Hi extends Vi {
    constructor(e, t, n, a) {
      super(), this.blockLen = e, this.outputLen = t, this.padOffset = n, this.isLE = a, this.finished = false, this.length = 0, this.pos = 0, this.destroyed = false, this.buffer = new Uint8Array(e), this.view = xn(this.buffer);
    }
    update(e) {
      Xn(this);
      const { view: t, buffer: n, blockLen: a } = this;
      e = Ts(e);
      const i = e.length;
      for (let u = 0; u < i; ) {
        const l = Math.min(a - this.pos, i - u);
        if (l === a) {
          const x = xn(e);
          for (; a <= i - u; u += a) this.process(x, u);
          continue;
        }
        n.set(e.subarray(u, u + l), this.pos), this.pos += l, u += l, this.pos === a && (this.process(t, 0), this.pos = 0);
      }
      return this.length += e.length, this.roundClean(), this;
    }
    digestInto(e) {
      Xn(this), zi(e, this), this.finished = true;
      const { buffer: t, view: n, blockLen: a, isLE: i } = this;
      let { pos: u } = this;
      t[u++] = 128, this.buffer.subarray(u).fill(0), this.padOffset > a - u && (this.process(n, 0), u = 0);
      for (let I = u; I < a; I++) t[I] = 0;
      Yi(n, a - 8, BigInt(this.length * 8), i), this.process(n, 0);
      const l = xn(e), x = this.outputLen;
      if (x % 4) throw new Error("_sha2: outputLen should be aligned to 32bit");
      const p = x / 4, g = this.get();
      if (p > g.length) throw new Error("_sha2: outputLen bigger than state");
      for (let I = 0; I < p; I++) l.setUint32(4 * I, g[I], i);
    }
    digest() {
      const { buffer: e, outputLen: t } = this;
      this.digestInto(e);
      const n = e.slice(0, t);
      return this.destroy(), n;
    }
    _cloneInto(e) {
      e || (e = new this.constructor()), e.set(...this.get());
      const { blockLen: t, buffer: n, length: a, finished: i, destroyed: u, pos: l } = this;
      return e.length = a, e.pos = l, e.finished = i, e.destroyed = u, a % t && e.buffer.set(n), e;
    }
  }
  const Yr = BigInt(2 ** 32 - 1), Cn = BigInt(32);
  function Bs(r, e = false) {
    return e ? {
      h: Number(r & Yr),
      l: Number(r >> Cn & Yr)
    } : {
      h: Number(r >> Cn & Yr) | 0,
      l: Number(r & Yr) | 0
    };
  }
  function Fi(r, e = false) {
    let t = new Uint32Array(r.length), n = new Uint32Array(r.length);
    for (let a = 0; a < r.length; a++) {
      const { h: i, l: u } = Bs(r[a], e);
      [t[a], n[a]] = [
        i,
        u
      ];
    }
    return [
      t,
      n
    ];
  }
  const qi = (r, e) => BigInt(r >>> 0) << Cn | BigInt(e >>> 0), Gi = (r, e, t) => r >>> t, Wi = (r, e, t) => r << 32 - t | e >>> t, Ki = (r, e, t) => r >>> t | e << 32 - t, Xi = (r, e, t) => r << 32 - t | e >>> t, Ji = (r, e, t) => r << 64 - t | e >>> t - 32, Qi = (r, e, t) => r >>> t - 32 | e << 64 - t, eo = (r, e) => e, to = (r, e) => r, ro = (r, e, t) => r << t | e >>> 32 - t, no = (r, e, t) => e << t | r >>> 32 - t, so = (r, e, t) => e << t - 32 | r >>> 64 - t, ao = (r, e, t) => r << t - 32 | e >>> 64 - t;
  function io(r, e, t, n) {
    const a = (e >>> 0) + (n >>> 0);
    return {
      h: r + t + (a / 2 ** 32 | 0) | 0,
      l: a | 0
    };
  }
  const oo = (r, e, t) => (r >>> 0) + (e >>> 0) + (t >>> 0), fo = (r, e, t, n) => e + t + n + (r / 2 ** 32 | 0) | 0, co = (r, e, t, n) => (r >>> 0) + (e >>> 0) + (t >>> 0) + (n >>> 0), uo = (r, e, t, n, a) => e + t + n + a + (r / 2 ** 32 | 0) | 0, lo = (r, e, t, n, a) => (r >>> 0) + (e >>> 0) + (t >>> 0) + (n >>> 0) + (a >>> 0), ho = (r, e, t, n, a, i) => e + t + n + a + i + (r / 2 ** 32 | 0) | 0, le = {
    fromBig: Bs,
    split: Fi,
    toBig: qi,
    shrSH: Gi,
    shrSL: Wi,
    rotrSH: Ki,
    rotrSL: Xi,
    rotrBH: Ji,
    rotrBL: Qi,
    rotr32H: eo,
    rotr32L: to,
    rotlSH: ro,
    rotlSL: no,
    rotlBH: so,
    rotlBL: ao,
    add: io,
    add3L: oo,
    add3H: fo,
    add4L: co,
    add4H: uo,
    add5H: ho,
    add5L: lo
  }, [xo, po] = le.split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((r) => BigInt(r))), Zt = new Uint32Array(80), Nt = new Uint32Array(80);
  class go extends Hi {
    constructor() {
      super(128, 64, 16, false), this.Ah = 1779033703, this.Al = -205731576, this.Bh = -1150833019, this.Bl = -2067093701, this.Ch = 1013904242, this.Cl = -23791573, this.Dh = -1521486534, this.Dl = 1595750129, this.Eh = 1359893119, this.El = -1377402159, this.Fh = -1694144372, this.Fl = 725511199, this.Gh = 528734635, this.Gl = -79577749, this.Hh = 1541459225, this.Hl = 327033209;
    }
    get() {
      const { Ah: e, Al: t, Bh: n, Bl: a, Ch: i, Cl: u, Dh: l, Dl: x, Eh: p, El: g, Fh: I, Fl: Y, Gh: F, Gl: de, Hh: xe, Hl: Me } = this;
      return [
        e,
        t,
        n,
        a,
        i,
        u,
        l,
        x,
        p,
        g,
        I,
        Y,
        F,
        de,
        xe,
        Me
      ];
    }
    set(e, t, n, a, i, u, l, x, p, g, I, Y, F, de, xe, Me) {
      this.Ah = e | 0, this.Al = t | 0, this.Bh = n | 0, this.Bl = a | 0, this.Ch = i | 0, this.Cl = u | 0, this.Dh = l | 0, this.Dl = x | 0, this.Eh = p | 0, this.El = g | 0, this.Fh = I | 0, this.Fl = Y | 0, this.Gh = F | 0, this.Gl = de | 0, this.Hh = xe | 0, this.Hl = Me | 0;
    }
    process(e, t) {
      for (let N = 0; N < 16; N++, t += 4) Zt[N] = e.getUint32(t), Nt[N] = e.getUint32(t += 4);
      for (let N = 16; N < 80; N++) {
        const ke = Zt[N - 15] | 0, Oe = Nt[N - 15] | 0, Ce = le.rotrSH(ke, Oe, 1) ^ le.rotrSH(ke, Oe, 8) ^ le.shrSH(ke, Oe, 7), Fe = le.rotrSL(ke, Oe, 1) ^ le.rotrSL(ke, Oe, 8) ^ le.shrSL(ke, Oe, 7), Ue = Zt[N - 2] | 0, Ze = Nt[N - 2] | 0, We = le.rotrSH(Ue, Ze, 19) ^ le.rotrBH(Ue, Ze, 61) ^ le.shrSH(Ue, Ze, 6), Ne = le.rotrSL(Ue, Ze, 19) ^ le.rotrBL(Ue, Ze, 61) ^ le.shrSL(Ue, Ze, 6), ct = le.add4L(Fe, Ne, Nt[N - 7], Nt[N - 16]), dt = le.add4H(ct, Ce, We, Zt[N - 7], Zt[N - 16]);
        Zt[N] = dt | 0, Nt[N] = ct | 0;
      }
      let { Ah: n, Al: a, Bh: i, Bl: u, Ch: l, Cl: x, Dh: p, Dl: g, Eh: I, El: Y, Fh: F, Fl: de, Gh: xe, Gl: Me, Hh: Ge, Hl: ge } = this;
      for (let N = 0; N < 80; N++) {
        const ke = le.rotrSH(I, Y, 14) ^ le.rotrSH(I, Y, 18) ^ le.rotrBH(I, Y, 41), Oe = le.rotrSL(I, Y, 14) ^ le.rotrSL(I, Y, 18) ^ le.rotrBL(I, Y, 41), Ce = I & F ^ ~I & xe, Fe = Y & de ^ ~Y & Me, Ue = le.add5L(ge, Oe, Fe, po[N], Nt[N]), Ze = le.add5H(Ue, Ge, ke, Ce, xo[N], Zt[N]), We = Ue | 0, Ne = le.rotrSH(n, a, 28) ^ le.rotrBH(n, a, 34) ^ le.rotrBH(n, a, 39), ct = le.rotrSL(n, a, 28) ^ le.rotrBL(n, a, 34) ^ le.rotrBL(n, a, 39), dt = n & i ^ n & l ^ i & l, _t = a & u ^ a & x ^ u & x;
        Ge = xe | 0, ge = Me | 0, xe = F | 0, Me = de | 0, F = I | 0, de = Y | 0, { h: I, l: Y } = le.add(p | 0, g | 0, Ze | 0, We | 0), p = l | 0, g = x | 0, l = i | 0, x = u | 0, i = n | 0, u = a | 0;
        const lt = le.add3L(We, ct, _t);
        n = le.add3H(lt, Ze, Ne, dt), a = lt | 0;
      }
      ({ h: n, l: a } = le.add(this.Ah | 0, this.Al | 0, n | 0, a | 0)), { h: i, l: u } = le.add(this.Bh | 0, this.Bl | 0, i | 0, u | 0), { h: l, l: x } = le.add(this.Ch | 0, this.Cl | 0, l | 0, x | 0), { h: p, l: g } = le.add(this.Dh | 0, this.Dl | 0, p | 0, g | 0), { h: I, l: Y } = le.add(this.Eh | 0, this.El | 0, I | 0, Y | 0), { h: F, l: de } = le.add(this.Fh | 0, this.Fl | 0, F | 0, de | 0), { h: xe, l: Me } = le.add(this.Gh | 0, this.Gl | 0, xe | 0, Me | 0), { h: Ge, l: ge } = le.add(this.Hh | 0, this.Hl | 0, Ge | 0, ge | 0), this.set(n, a, i, u, l, x, p, g, I, Y, F, de, xe, Me, Ge, ge);
    }
    roundClean() {
      Zt.fill(0), Nt.fill(0);
    }
    destroy() {
      this.buffer.fill(0), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  const yo = Pi(() => new go());
  const jn = BigInt(0), Is = BigInt(1), mo = BigInt(2);
  function Ln(r) {
    return r instanceof Uint8Array || ArrayBuffer.isView(r) && r.constructor.name === "Uint8Array";
  }
  function Dn(r) {
    if (!Ln(r)) throw new Error("Uint8Array expected");
  }
  function pn(r, e) {
    if (typeof e != "boolean") throw new Error(r + " boolean expected, got " + e);
  }
  const vo = Array.from({
    length: 256
  }, (r, e) => e.toString(16).padStart(2, "0"));
  function zn(r) {
    Dn(r);
    let e = "";
    for (let t = 0; t < r.length; t++) e += vo[r[t]];
    return e;
  }
  function Cs(r) {
    if (typeof r != "string") throw new Error("hex string expected, got " + typeof r);
    return r === "" ? jn : BigInt("0x" + r);
  }
  const kt = {
    _0: 48,
    _9: 57,
    A: 65,
    F: 70,
    a: 97,
    f: 102
  };
  function Jn(r) {
    if (r >= kt._0 && r <= kt._9) return r - kt._0;
    if (r >= kt.A && r <= kt.F) return r - (kt.A - 10);
    if (r >= kt.a && r <= kt.f) return r - (kt.a - 10);
  }
  function Zs(r) {
    if (typeof r != "string") throw new Error("hex string expected, got " + typeof r);
    const e = r.length, t = e / 2;
    if (e % 2) throw new Error("hex string expected, got unpadded hex of length " + e);
    const n = new Uint8Array(t);
    for (let a = 0, i = 0; a < t; a++, i += 2) {
      const u = Jn(r.charCodeAt(i)), l = Jn(r.charCodeAt(i + 1));
      if (u === void 0 || l === void 0) {
        const x = r[i] + r[i + 1];
        throw new Error('hex string expected, got non-hex character "' + x + '" at index ' + i);
      }
      n[a] = u * 16 + l;
    }
    return n;
  }
  function bo(r) {
    return Cs(zn(r));
  }
  function ir(r) {
    return Dn(r), Cs(zn(Uint8Array.from(r).reverse()));
  }
  function Ns(r, e) {
    return Zs(r.toString(16).padStart(e * 2, "0"));
  }
  function tn(r, e) {
    return Ns(r, e).reverse();
  }
  function gt(r, e, t) {
    let n;
    if (typeof e == "string") try {
      n = Zs(e);
    } catch (i) {
      throw new Error(r + " must be hex string or Uint8Array, cause: " + i);
    }
    else if (Ln(e)) n = Uint8Array.from(e);
    else throw new Error(r + " must be hex string or Uint8Array");
    const a = n.length;
    if (typeof t == "number" && a !== t) throw new Error(r + " of length " + t + " expected, got " + a);
    return n;
  }
  function Qn(...r) {
    let e = 0;
    for (let n = 0; n < r.length; n++) {
      const a = r[n];
      Dn(a), e += a.length;
    }
    const t = new Uint8Array(e);
    for (let n = 0, a = 0; n < r.length; n++) {
      const i = r[n];
      t.set(i, a), a += i.length;
    }
    return t;
  }
  const gn = (r) => typeof r == "bigint" && jn <= r;
  function _o(r, e, t) {
    return gn(r) && gn(e) && gn(t) && e <= r && r < t;
  }
  function Pt(r, e, t, n) {
    if (!_o(e, t, n)) throw new Error("expected valid " + r + ": " + t + " <= n < " + n + ", got " + e);
  }
  function wo(r) {
    let e;
    for (e = 0; r > jn; r >>= Is, e += 1) ;
    return e;
  }
  const Ao = (r) => (mo << BigInt(r - 1)) - Is, Eo = {
    bigint: (r) => typeof r == "bigint",
    function: (r) => typeof r == "function",
    boolean: (r) => typeof r == "boolean",
    string: (r) => typeof r == "string",
    stringOrUint8Array: (r) => typeof r == "string" || Ln(r),
    isSafeInteger: (r) => Number.isSafeInteger(r),
    array: (r) => Array.isArray(r),
    field: (r, e) => e.Fp.isValid(r),
    hash: (r) => typeof r == "function" && Number.isSafeInteger(r.outputLen)
  };
  function nn(r, e, t = {}) {
    const n = (a, i, u) => {
      const l = Eo[i];
      if (typeof l != "function") throw new Error("invalid validator function");
      const x = r[a];
      if (!(u && x === void 0) && !l(x, r)) throw new Error("param " + String(a) + " is invalid. Expected " + i + ", got " + x);
    };
    for (const [a, i] of Object.entries(e)) n(a, i, false);
    for (const [a, i] of Object.entries(t)) n(a, i, true);
    return r;
  }
  function es(r) {
    const e = /* @__PURE__ */ new WeakMap();
    return (t, ...n) => {
      const a = e.get(t);
      if (a !== void 0) return a;
      const i = r(t, ...n);
      return e.set(t, i), i;
    };
  }
  const qe = BigInt(0), Pe = BigInt(1), Yt = BigInt(2), So = BigInt(3), Zn = BigInt(4), ts = BigInt(5), rs = BigInt(8);
  function Ve(r, e) {
    const t = r % e;
    return t >= qe ? t : e + t;
  }
  function Rs(r, e, t) {
    if (e < qe) throw new Error("invalid exponent, negatives unsupported");
    if (t <= qe) throw new Error("invalid modulus");
    if (t === Pe) return qe;
    let n = Pe;
    for (; e > qe; ) e & Pe && (n = n * r % t), r = r * r % t, e >>= Pe;
    return n;
  }
  function pt(r, e, t) {
    let n = r;
    for (; e-- > qe; ) n *= n, n %= t;
    return n;
  }
  function ns(r, e) {
    if (r === qe) throw new Error("invert: expected non-zero number");
    if (e <= qe) throw new Error("invert: expected positive modulus, got " + e);
    let t = Ve(r, e), n = e, a = qe, i = Pe;
    for (; t !== qe; ) {
      const l = n / t, x = n % t, p = a - i * l;
      n = t, t = x, a = i, i = p;
    }
    if (n !== Pe) throw new Error("invert: does not exist");
    return Ve(a, e);
  }
  function To(r) {
    const e = (r - Pe) / Yt;
    let t, n, a;
    for (t = r - Pe, n = 0; t % Yt === qe; t /= Yt, n++) ;
    for (a = Yt; a < r && Rs(a, e, r) !== r - Pe; a++) if (a > 1e3) throw new Error("Cannot find square root: likely non-prime P");
    if (n === 1) {
      const u = (r + Pe) / Zn;
      return function(x, p) {
        const g = x.pow(p, u);
        if (!x.eql(x.sqr(g), p)) throw new Error("Cannot find square root");
        return g;
      };
    }
    const i = (t + Pe) / Yt;
    return function(l, x) {
      if (l.pow(x, e) === l.neg(l.ONE)) throw new Error("Cannot find square root");
      let p = n, g = l.pow(l.mul(l.ONE, a), t), I = l.pow(x, i), Y = l.pow(x, t);
      for (; !l.eql(Y, l.ONE); ) {
        if (l.eql(Y, l.ZERO)) return l.ZERO;
        let F = 1;
        for (let xe = l.sqr(Y); F < p && !l.eql(xe, l.ONE); F++) xe = l.sqr(xe);
        const de = l.pow(g, Pe << BigInt(p - F - 1));
        g = l.sqr(de), I = l.mul(I, de), Y = l.mul(Y, g), p = F;
      }
      return I;
    };
  }
  function ko(r) {
    if (r % Zn === So) {
      const e = (r + Pe) / Zn;
      return function(n, a) {
        const i = n.pow(a, e);
        if (!n.eql(n.sqr(i), a)) throw new Error("Cannot find square root");
        return i;
      };
    }
    if (r % rs === ts) {
      const e = (r - ts) / rs;
      return function(n, a) {
        const i = n.mul(a, Yt), u = n.pow(i, e), l = n.mul(a, u), x = n.mul(n.mul(l, Yt), u), p = n.mul(l, n.sub(x, n.ONE));
        if (!n.eql(n.sqr(p), a)) throw new Error("Cannot find square root");
        return p;
      };
    }
    return To(r);
  }
  const Bo = (r, e) => (Ve(r, e) & Pe) === Pe, Io = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function Co(r) {
    const e = {
      ORDER: "bigint",
      MASK: "bigint",
      BYTES: "isSafeInteger",
      BITS: "isSafeInteger"
    }, t = Io.reduce((n, a) => (n[a] = "function", n), e);
    return nn(r, t);
  }
  function Zo(r, e, t) {
    if (t < qe) throw new Error("invalid exponent, negatives unsupported");
    if (t === qe) return r.ONE;
    if (t === Pe) return e;
    let n = r.ONE, a = e;
    for (; t > qe; ) t & Pe && (n = r.mul(n, a)), a = r.sqr(a), t >>= Pe;
    return n;
  }
  function No(r, e) {
    const t = new Array(e.length), n = e.reduce((i, u, l) => r.is0(u) ? i : (t[l] = i, r.mul(i, u)), r.ONE), a = r.inv(n);
    return e.reduceRight((i, u, l) => r.is0(u) ? i : (t[l] = r.mul(i, t[l]), r.mul(i, u)), a), t;
  }
  function Os(r, e) {
    const t = e !== void 0 ? e : r.toString(2).length, n = Math.ceil(t / 8);
    return {
      nBitLength: t,
      nByteLength: n
    };
  }
  function Ms(r, e, t = false, n = {}) {
    if (r <= qe) throw new Error("invalid field: expected ORDER > 0, got " + r);
    const { nBitLength: a, nByteLength: i } = Os(r, e);
    if (i > 2048) throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    let u;
    const l = Object.freeze({
      ORDER: r,
      isLE: t,
      BITS: a,
      BYTES: i,
      MASK: Ao(a),
      ZERO: qe,
      ONE: Pe,
      create: (x) => Ve(x, r),
      isValid: (x) => {
        if (typeof x != "bigint") throw new Error("invalid field element: expected bigint, got " + typeof x);
        return qe <= x && x < r;
      },
      is0: (x) => x === qe,
      isOdd: (x) => (x & Pe) === Pe,
      neg: (x) => Ve(-x, r),
      eql: (x, p) => x === p,
      sqr: (x) => Ve(x * x, r),
      add: (x, p) => Ve(x + p, r),
      sub: (x, p) => Ve(x - p, r),
      mul: (x, p) => Ve(x * p, r),
      pow: (x, p) => Zo(l, x, p),
      div: (x, p) => Ve(x * ns(p, r), r),
      sqrN: (x) => x * x,
      addN: (x, p) => x + p,
      subN: (x, p) => x - p,
      mulN: (x, p) => x * p,
      inv: (x) => ns(x, r),
      sqrt: n.sqrt || ((x) => (u || (u = ko(r)), u(l, x))),
      invertBatch: (x) => No(l, x),
      cmov: (x, p, g) => g ? p : x,
      toBytes: (x) => t ? tn(x, i) : Ns(x, i),
      fromBytes: (x) => {
        if (x.length !== i) throw new Error("Field.fromBytes: expected " + i + " bytes, got " + x.length);
        return t ? ir(x) : bo(x);
      }
    });
    return Object.freeze(l);
  }
  const ss = BigInt(0), Hr = BigInt(1);
  function yn(r, e) {
    const t = e.negate();
    return r ? t : e;
  }
  function Us(r, e) {
    if (!Number.isSafeInteger(r) || r <= 0 || r > e) throw new Error("invalid window size, expected [1.." + e + "], got W=" + r);
  }
  function mn(r, e) {
    Us(r, e);
    const t = Math.ceil(e / r) + 1, n = 2 ** (r - 1);
    return {
      windows: t,
      windowSize: n
    };
  }
  function Ro(r, e) {
    if (!Array.isArray(r)) throw new Error("array expected");
    r.forEach((t, n) => {
      if (!(t instanceof e)) throw new Error("invalid point at index " + n);
    });
  }
  function Oo(r, e) {
    if (!Array.isArray(r)) throw new Error("array of scalars expected");
    r.forEach((t, n) => {
      if (!e.isValid(t)) throw new Error("invalid scalar at index " + n);
    });
  }
  const vn = /* @__PURE__ */ new WeakMap(), js = /* @__PURE__ */ new WeakMap();
  function bn(r) {
    return js.get(r) || 1;
  }
  function Mo(r, e) {
    return {
      constTimeNegate: yn,
      hasPrecomputes(t) {
        return bn(t) !== 1;
      },
      unsafeLadder(t, n, a = r.ZERO) {
        let i = t;
        for (; n > ss; ) n & Hr && (a = a.add(i)), i = i.double(), n >>= Hr;
        return a;
      },
      precomputeWindow(t, n) {
        const { windows: a, windowSize: i } = mn(n, e), u = [];
        let l = t, x = l;
        for (let p = 0; p < a; p++) {
          x = l, u.push(x);
          for (let g = 1; g < i; g++) x = x.add(l), u.push(x);
          l = x.double();
        }
        return u;
      },
      wNAF(t, n, a) {
        const { windows: i, windowSize: u } = mn(t, e);
        let l = r.ZERO, x = r.BASE;
        const p = BigInt(2 ** t - 1), g = 2 ** t, I = BigInt(t);
        for (let Y = 0; Y < i; Y++) {
          const F = Y * u;
          let de = Number(a & p);
          a >>= I, de > u && (de -= g, a += Hr);
          const xe = F, Me = F + Math.abs(de) - 1, Ge = Y % 2 !== 0, ge = de < 0;
          de === 0 ? x = x.add(yn(Ge, n[xe])) : l = l.add(yn(ge, n[Me]));
        }
        return {
          p: l,
          f: x
        };
      },
      wNAFUnsafe(t, n, a, i = r.ZERO) {
        const { windows: u, windowSize: l } = mn(t, e), x = BigInt(2 ** t - 1), p = 2 ** t, g = BigInt(t);
        for (let I = 0; I < u; I++) {
          const Y = I * l;
          if (a === ss) break;
          let F = Number(a & x);
          if (a >>= g, F > l && (F -= p, a += Hr), F === 0) continue;
          let de = n[Y + Math.abs(F) - 1];
          F < 0 && (de = de.negate()), i = i.add(de);
        }
        return i;
      },
      getPrecomputes(t, n, a) {
        let i = vn.get(n);
        return i || (i = this.precomputeWindow(n, t), t !== 1 && vn.set(n, a(i))), i;
      },
      wNAFCached(t, n, a) {
        const i = bn(t);
        return this.wNAF(i, this.getPrecomputes(i, t, a), n);
      },
      wNAFCachedUnsafe(t, n, a, i) {
        const u = bn(t);
        return u === 1 ? this.unsafeLadder(t, n, i) : this.wNAFUnsafe(u, this.getPrecomputes(u, t, a), n, i);
      },
      setWindowSize(t, n) {
        Us(n, e), js.set(t, n), vn.delete(t);
      }
    };
  }
  function Uo(r, e, t, n) {
    if (Ro(t, r), Oo(n, e), t.length !== n.length) throw new Error("arrays of points and scalars must have equal length");
    const a = r.ZERO, i = wo(BigInt(t.length)), u = i > 12 ? i - 3 : i > 4 ? i - 2 : i ? 2 : 1, l = (1 << u) - 1, x = new Array(l + 1).fill(a), p = Math.floor((e.BITS - 1) / u) * u;
    let g = a;
    for (let I = p; I >= 0; I -= u) {
      x.fill(a);
      for (let F = 0; F < n.length; F++) {
        const de = n[F], xe = Number(de >> BigInt(I) & BigInt(l));
        x[xe] = x[xe].add(t[F]);
      }
      let Y = a;
      for (let F = x.length - 1, de = a; F > 0; F--) de = de.add(x[F]), Y = Y.add(de);
      if (g = g.add(Y), I !== 0) for (let F = 0; F < u; F++) g = g.double();
    }
    return g;
  }
  function jo(r) {
    return Co(r.Fp), nn(r, {
      n: "bigint",
      h: "bigint",
      Gx: "field",
      Gy: "field"
    }, {
      nBitLength: "isSafeInteger",
      nByteLength: "isSafeInteger"
    }), Object.freeze({
      ...Os(r.n, r.nBitLength),
      ...r,
      p: r.Fp.ORDER
    });
  }
  const xt = BigInt(0), at = BigInt(1), Fr = BigInt(2), Lo = BigInt(8), Do = {
    zip215: true
  };
  function zo(r) {
    const e = jo(r);
    return nn(r, {
      hash: "function",
      a: "bigint",
      d: "bigint",
      randomBytes: "function"
    }, {
      adjustScalarBytes: "function",
      domain: "function",
      uvRatio: "function",
      mapToCurve: "function"
    }), Object.freeze({
      ...e
    });
  }
  function $o(r) {
    const e = zo(r), { Fp: t, n, prehash: a, hash: i, randomBytes: u, nByteLength: l, h: x } = e, p = Fr << BigInt(l * 8) - at, g = t.create, I = Ms(e.n, e.nBitLength), Y = e.uvRatio || ((q, B) => {
      try {
        return {
          isValid: true,
          value: t.sqrt(q * t.inv(B))
        };
      } catch {
        return {
          isValid: false,
          value: xt
        };
      }
    }), F = e.adjustScalarBytes || ((q) => q), de = e.domain || ((q, B, V) => {
      if (pn("phflag", V), B.length || V) throw new Error("Contexts/pre-hash are not supported");
      return q;
    });
    function xe(q, B) {
      Pt("coordinate " + q, B, xt, p);
    }
    function Me(q) {
      if (!(q instanceof N)) throw new Error("ExtendedPoint expected");
    }
    const Ge = es((q, B) => {
      const { ex: V, ey: G, ez: ye } = q, ve = q.is0();
      B == null && (B = ve ? Lo : t.inv(ye));
      const be = g(V * B), me = g(G * B), fe = g(ye * B);
      if (ve) return {
        x: xt,
        y: at
      };
      if (fe !== at) throw new Error("invZ was invalid");
      return {
        x: be,
        y: me
      };
    }), ge = es((q) => {
      const { a: B, d: V } = e;
      if (q.is0()) throw new Error("bad point: ZERO");
      const { ex: G, ey: ye, ez: ve, et: be } = q, me = g(G * G), fe = g(ye * ye), z = g(ve * ve), Be = g(z * z), Ke = g(me * B), it = g(z * g(Ke + fe)), rt = g(Be + g(V * g(me * fe)));
      if (it !== rt) throw new Error("bad point: equation left != right (1)");
      const Xe = g(G * ye), ht = g(ve * be);
      if (Xe !== ht) throw new Error("bad point: equation left != right (2)");
      return true;
    });
    class N {
      constructor(B, V, G, ye) {
        this.ex = B, this.ey = V, this.ez = G, this.et = ye, xe("x", B), xe("y", V), xe("z", G), xe("t", ye), Object.freeze(this);
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      static fromAffine(B) {
        if (B instanceof N) throw new Error("extended point not allowed");
        const { x: V, y: G } = B || {};
        return xe("x", V), xe("y", G), new N(V, G, at, g(V * G));
      }
      static normalizeZ(B) {
        const V = t.invertBatch(B.map((G) => G.ez));
        return B.map((G, ye) => G.toAffine(V[ye])).map(N.fromAffine);
      }
      static msm(B, V) {
        return Uo(N, I, B, V);
      }
      _setWindowSize(B) {
        Ce.setWindowSize(this, B);
      }
      assertValidity() {
        ge(this);
      }
      equals(B) {
        Me(B);
        const { ex: V, ey: G, ez: ye } = this, { ex: ve, ey: be, ez: me } = B, fe = g(V * me), z = g(ve * ye), Be = g(G * me), Ke = g(be * ye);
        return fe === z && Be === Ke;
      }
      is0() {
        return this.equals(N.ZERO);
      }
      negate() {
        return new N(g(-this.ex), this.ey, this.ez, g(-this.et));
      }
      double() {
        const { a: B } = e, { ex: V, ey: G, ez: ye } = this, ve = g(V * V), be = g(G * G), me = g(Fr * g(ye * ye)), fe = g(B * ve), z = V + G, Be = g(g(z * z) - ve - be), Ke = fe + be, it = Ke - me, rt = fe - be, Xe = g(Be * it), ht = g(Ke * rt), ut = g(Be * rt), jt = g(it * Ke);
        return new N(Xe, ht, jt, ut);
      }
      add(B) {
        Me(B);
        const { a: V, d: G } = e, { ex: ye, ey: ve, ez: be, et: me } = this, { ex: fe, ey: z, ez: Be, et: Ke } = B;
        if (V === BigInt(-1)) {
          const Lt = g((ve - ye) * (z + fe)), ur = g((ve + ye) * (z - fe)), Dt = g(ur - Lt);
          if (Dt === xt) return this.double();
          const Wt = g(be * Fr * Ke), zt = g(me * Fr * Be), Kt = zt + Wt, $t = ur + Lt, Xt = zt - Wt, lr = g(Kt * Dt), $r = g($t * Xt), an = g(Kt * Xt), hr = g(Dt * $t);
          return new N(lr, $r, hr, an);
        }
        const it = g(ye * fe), rt = g(ve * z), Xe = g(me * G * Ke), ht = g(be * Be), ut = g((ye + ve) * (fe + z) - it - rt), jt = ht - Xe, jr = ht + Xe, Lr = g(rt - V * it), sn = g(ut * jt), Dr = g(jr * Lr), zr = g(ut * Lr), St = g(jt * jr);
        return new N(sn, Dr, St, zr);
      }
      subtract(B) {
        return this.add(B.negate());
      }
      wNAF(B) {
        return Ce.wNAFCached(this, B, N.normalizeZ);
      }
      multiply(B) {
        const V = B;
        Pt("scalar", V, at, n);
        const { p: G, f: ye } = this.wNAF(V);
        return N.normalizeZ([
          G,
          ye
        ])[0];
      }
      multiplyUnsafe(B, V = N.ZERO) {
        const G = B;
        return Pt("scalar", G, xt, n), G === xt ? Oe : this.is0() || G === at ? this : Ce.wNAFCachedUnsafe(this, G, N.normalizeZ, V);
      }
      isSmallOrder() {
        return this.multiplyUnsafe(x).is0();
      }
      isTorsionFree() {
        return Ce.unsafeLadder(this, n).is0();
      }
      toAffine(B) {
        return Ge(this, B);
      }
      clearCofactor() {
        const { h: B } = e;
        return B === at ? this : this.multiplyUnsafe(B);
      }
      static fromHex(B, V = false) {
        const { d: G, a: ye } = e, ve = t.BYTES;
        B = gt("pointHex", B, ve), pn("zip215", V);
        const be = B.slice(), me = B[ve - 1];
        be[ve - 1] = me & -129;
        const fe = ir(be), z = V ? p : t.ORDER;
        Pt("pointHex.y", fe, xt, z);
        const Be = g(fe * fe), Ke = g(Be - at), it = g(G * Be - ye);
        let { isValid: rt, value: Xe } = Y(Ke, it);
        if (!rt) throw new Error("Point.fromHex: invalid y coordinate");
        const ht = (Xe & at) === at, ut = (me & 128) !== 0;
        if (!V && Xe === xt && ut) throw new Error("Point.fromHex: x=0 and x_0=1");
        return ut !== ht && (Xe = g(-Xe)), N.fromAffine({
          x: Xe,
          y: fe
        });
      }
      static fromPrivateKey(B) {
        return Ze(B).point;
      }
      toRawBytes() {
        const { x: B, y: V } = this.toAffine(), G = tn(V, t.BYTES);
        return G[G.length - 1] |= B & at ? 128 : 0, G;
      }
      toHex() {
        return zn(this.toRawBytes());
      }
    }
    N.BASE = new N(e.Gx, e.Gy, at, g(e.Gx * e.Gy)), N.ZERO = new N(xt, at, at, xt);
    const { BASE: ke, ZERO: Oe } = N, Ce = Mo(N, l * 8);
    function Fe(q) {
      return Ve(q, n);
    }
    function Ue(q) {
      return Fe(ir(q));
    }
    function Ze(q) {
      const B = t.BYTES;
      q = gt("private key", q, B);
      const V = gt("hashed private key", i(q), 2 * B), G = F(V.slice(0, B)), ye = V.slice(B, 2 * B), ve = Ue(G), be = ke.multiply(ve), me = be.toRawBytes();
      return {
        head: G,
        prefix: ye,
        scalar: ve,
        point: be,
        pointBytes: me
      };
    }
    function We(q) {
      return Ze(q).pointBytes;
    }
    function Ne(q = new Uint8Array(), ...B) {
      const V = Qn(...B);
      return Ue(i(de(V, gt("context", q), !!a)));
    }
    function ct(q, B, V = {}) {
      q = gt("message", q), a && (q = a(q));
      const { prefix: G, scalar: ye, pointBytes: ve } = Ze(B), be = Ne(V.context, G, q), me = ke.multiply(be).toRawBytes(), fe = Ne(V.context, me, ve, q), z = Fe(be + fe * ye);
      Pt("signature.s", z, xt, n);
      const Be = Qn(me, tn(z, t.BYTES));
      return gt("result", Be, t.BYTES * 2);
    }
    const dt = Do;
    function _t(q, B, V, G = dt) {
      const { context: ye, zip215: ve } = G, be = t.BYTES;
      q = gt("signature", q, 2 * be), B = gt("message", B), V = gt("publicKey", V, be), ve !== void 0 && pn("zip215", ve), a && (B = a(B));
      const me = ir(q.slice(be, 2 * be));
      let fe, z, Be;
      try {
        fe = N.fromHex(V, ve), z = N.fromHex(q.slice(0, be), ve), Be = ke.multiplyUnsafe(me);
      } catch {
        return false;
      }
      if (!ve && fe.isSmallOrder()) return false;
      const Ke = Ne(ye, z.toRawBytes(), fe.toRawBytes(), B);
      return z.add(fe.multiplyUnsafe(Ke)).subtract(Be).clearCofactor().equals(N.ZERO);
    }
    return ke._setWindowSize(8), {
      CURVE: e,
      getPublicKey: We,
      sign: ct,
      verify: _t,
      ExtendedPoint: N,
      utils: {
        getExtendedPublicKey: Ze,
        randomPrivateKey: () => u(t.BYTES),
        precompute(q = 8, B = N.BASE) {
          return B._setWindowSize(q), B.multiply(BigInt(3)), B;
        }
      }
    };
  }
  const tr = BigInt(0), _n = BigInt(1);
  function Vo(r) {
    return nn(r, {
      a: "bigint"
    }, {
      montgomeryBits: "isSafeInteger",
      nByteLength: "isSafeInteger",
      adjustScalarBytes: "function",
      domain: "function",
      powPminus2: "function",
      Gu: "bigint"
    }), Object.freeze({
      ...r
    });
  }
  function Po(r) {
    const e = Vo(r), { P: t } = e, n = (ge) => Ve(ge, t), a = e.montgomeryBits, i = Math.ceil(a / 8), u = e.nByteLength, l = e.adjustScalarBytes || ((ge) => ge), x = e.powPminus2 || ((ge) => Rs(ge, t - BigInt(2), t));
    function p(ge, N, ke) {
      const Oe = n(ge * (N - ke));
      return N = n(N - Oe), ke = n(ke + Oe), [
        N,
        ke
      ];
    }
    const g = (e.a - BigInt(2)) / BigInt(4);
    function I(ge, N) {
      Pt("u", ge, tr, t), Pt("scalar", N, tr, t);
      const ke = N, Oe = ge;
      let Ce = _n, Fe = tr, Ue = ge, Ze = _n, We = tr, Ne;
      for (let dt = BigInt(a - 1); dt >= tr; dt--) {
        const _t = ke >> dt & _n;
        We ^= _t, Ne = p(We, Ce, Ue), Ce = Ne[0], Ue = Ne[1], Ne = p(We, Fe, Ze), Fe = Ne[0], Ze = Ne[1], We = _t;
        const lt = Ce + Fe, q = n(lt * lt), B = Ce - Fe, V = n(B * B), G = q - V, ye = Ue + Ze, ve = Ue - Ze, be = n(ve * lt), me = n(ye * B), fe = be + me, z = be - me;
        Ue = n(fe * fe), Ze = n(Oe * n(z * z)), Ce = n(q * V), Fe = n(G * (q + n(g * G)));
      }
      Ne = p(We, Ce, Ue), Ce = Ne[0], Ue = Ne[1], Ne = p(We, Fe, Ze), Fe = Ne[0], Ze = Ne[1];
      const ct = x(Fe);
      return n(Ce * ct);
    }
    function Y(ge) {
      return tn(n(ge), i);
    }
    function F(ge) {
      const N = gt("u coordinate", ge, i);
      return u === 32 && (N[31] &= 127), ir(N);
    }
    function de(ge) {
      const N = gt("scalar", ge), ke = N.length;
      if (ke !== i && ke !== u) {
        let Oe = "" + i + " or " + u;
        throw new Error("invalid scalar, expected " + Oe + " bytes, got " + ke);
      }
      return ir(l(N));
    }
    function xe(ge, N) {
      const ke = F(N), Oe = de(ge), Ce = I(ke, Oe);
      if (Ce === tr) throw new Error("invalid private or public key received");
      return Y(Ce);
    }
    const Me = Y(e.Gu);
    function Ge(ge) {
      return xe(ge, Me);
    }
    return {
      scalarMult: xe,
      scalarMultBase: Ge,
      getSharedSecret: (ge, N) => xe(ge, N),
      getPublicKey: (ge) => Ge(ge),
      utils: {
        randomPrivateKey: () => e.randomBytes(e.nByteLength)
      },
      GuBytes: Me
    };
  }
  const Mr = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949"), as = BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
  BigInt(0);
  const Yo = BigInt(1), is = BigInt(2), Ho = BigInt(3), Fo = BigInt(5), qo = BigInt(8);
  function Ls(r) {
    const e = BigInt(10), t = BigInt(20), n = BigInt(40), a = BigInt(80), i = Mr, l = r * r % i * r % i, x = pt(l, is, i) * l % i, p = pt(x, Yo, i) * r % i, g = pt(p, Fo, i) * p % i, I = pt(g, e, i) * g % i, Y = pt(I, t, i) * I % i, F = pt(Y, n, i) * Y % i, de = pt(F, a, i) * F % i, xe = pt(de, a, i) * F % i, Me = pt(xe, e, i) * g % i;
    return {
      pow_p_5_8: pt(Me, is, i) * r % i,
      b2: l
    };
  }
  function Ds(r) {
    return r[0] &= 248, r[31] &= 127, r[31] |= 64, r;
  }
  function Go(r, e) {
    const t = Mr, n = Ve(e * e * e, t), a = Ve(n * n * e, t), i = Ls(r * a).pow_p_5_8;
    let u = Ve(r * n * i, t);
    const l = Ve(e * u * u, t), x = u, p = Ve(u * as, t), g = l === r, I = l === Ve(-r, t), Y = l === Ve(-r * as, t);
    return g && (u = x), (I || Y) && (u = p), Bo(u, t) && (u = Ve(-u, t)), {
      isValid: g || I,
      value: u
    };
  }
  const qr = Ms(Mr, void 0, true), Nn = {
    a: BigInt(-1),
    d: BigInt("37095705934669439343138083508754565189542113879843219016388785533085940283555"),
    Fp: qr,
    n: BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989"),
    h: qo,
    Gx: BigInt("15112221349535400772501151409588531511454012693041857206046113283949847762202"),
    Gy: BigInt("46316835694926478169428394003475163141307993866256225615783033603165251855960"),
    hash: yo,
    randomBytes: ks,
    adjustScalarBytes: Ds,
    uvRatio: Go
  }, Wo = $o(Nn), Ko = Po({
    P: Mr,
    a: BigInt(486662),
    montgomeryBits: 255,
    nByteLength: 32,
    Gu: BigInt(9),
    powPminus2: (r) => {
      const e = Mr, { pow_p_5_8: t, b2: n } = Ls(r);
      return Ve(pt(t, Ho, e) * n, e);
    },
    adjustScalarBytes: Ds,
    randomBytes: ks
  });
  function Xo(r) {
    const { y: e } = Wo.ExtendedPoint.fromHex(r), t = BigInt(1);
    return qr.toBytes(qr.create((t + e) * qr.inv(t - e)));
  }
  function Jo(r) {
    const e = Nn.hash(r.subarray(0, 32));
    return Nn.adjustScalarBytes(e).subarray(0, 32);
  }
  function Qo(r) {
    throw new Error('Could not dynamically require "' + r + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
  }
  var wn = {
    exports: {}
  }, os;
  function ef() {
    return os || (os = 1, function(r) {
      (function(e) {
        var t = function(o) {
          var c, f = new Float64Array(16);
          if (o) for (c = 0; c < o.length; c++) f[c] = o[c];
          return f;
        }, n = function() {
          throw new Error("no PRNG");
        }, a = new Uint8Array(16), i = new Uint8Array(32);
        i[0] = 9;
        var u = t(), l = t([
          1
        ]), x = t([
          56129,
          1
        ]), p = t([
          30883,
          4953,
          19914,
          30187,
          55467,
          16705,
          2637,
          112,
          59544,
          30585,
          16505,
          36039,
          65139,
          11119,
          27886,
          20995
        ]), g = t([
          61785,
          9906,
          39828,
          60374,
          45398,
          33411,
          5274,
          224,
          53552,
          61171,
          33010,
          6542,
          64743,
          22239,
          55772,
          9222
        ]), I = t([
          54554,
          36645,
          11616,
          51542,
          42930,
          38181,
          51040,
          26924,
          56412,
          64982,
          57905,
          49316,
          21502,
          52590,
          14035,
          8553
        ]), Y = t([
          26200,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214,
          26214
        ]), F = t([
          41136,
          18958,
          6951,
          50414,
          58488,
          44335,
          6150,
          12099,
          55207,
          15867,
          153,
          11085,
          57099,
          20417,
          9344,
          11139
        ]);
        function de(o, c, f, s) {
          o[c] = f >> 24 & 255, o[c + 1] = f >> 16 & 255, o[c + 2] = f >> 8 & 255, o[c + 3] = f & 255, o[c + 4] = s >> 24 & 255, o[c + 5] = s >> 16 & 255, o[c + 6] = s >> 8 & 255, o[c + 7] = s & 255;
        }
        function xe(o, c, f, s, d) {
          var y, m = 0;
          for (y = 0; y < d; y++) m |= o[c + y] ^ f[s + y];
          return (1 & m - 1 >>> 8) - 1;
        }
        function Me(o, c, f, s) {
          return xe(o, c, f, s, 16);
        }
        function Ge(o, c, f, s) {
          return xe(o, c, f, s, 32);
        }
        function ge(o, c, f, s) {
          for (var d = s[0] & 255 | (s[1] & 255) << 8 | (s[2] & 255) << 16 | (s[3] & 255) << 24, y = f[0] & 255 | (f[1] & 255) << 8 | (f[2] & 255) << 16 | (f[3] & 255) << 24, m = f[4] & 255 | (f[5] & 255) << 8 | (f[6] & 255) << 16 | (f[7] & 255) << 24, w = f[8] & 255 | (f[9] & 255) << 8 | (f[10] & 255) << 16 | (f[11] & 255) << 24, k = f[12] & 255 | (f[13] & 255) << 8 | (f[14] & 255) << 16 | (f[15] & 255) << 24, $ = s[4] & 255 | (s[5] & 255) << 8 | (s[6] & 255) << 16 | (s[7] & 255) << 24, R = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, Ee = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, U = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, J = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24, Q = s[8] & 255 | (s[9] & 255) << 8 | (s[10] & 255) << 16 | (s[11] & 255) << 24, se = f[16] & 255 | (f[17] & 255) << 8 | (f[18] & 255) << 16 | (f[19] & 255) << 24, ne = f[20] & 255 | (f[21] & 255) << 8 | (f[22] & 255) << 16 | (f[23] & 255) << 24, ee = f[24] & 255 | (f[25] & 255) << 8 | (f[26] & 255) << 16 | (f[27] & 255) << 24, re = f[28] & 255 | (f[29] & 255) << 8 | (f[30] & 255) << 16 | (f[31] & 255) << 24, te = s[12] & 255 | (s[13] & 255) << 8 | (s[14] & 255) << 16 | (s[15] & 255) << 24, j = d, H = y, O = m, L = w, D = k, Z = $, v = R, b = Ee, E = U, _ = J, A = Q, S = se, W = ne, ae = ee, ce = re, ie = te, h, pe = 0; pe < 20; pe += 2) h = j + W | 0, D ^= h << 7 | h >>> 25, h = D + j | 0, E ^= h << 9 | h >>> 23, h = E + D | 0, W ^= h << 13 | h >>> 19, h = W + E | 0, j ^= h << 18 | h >>> 14, h = Z + H | 0, _ ^= h << 7 | h >>> 25, h = _ + Z | 0, ae ^= h << 9 | h >>> 23, h = ae + _ | 0, H ^= h << 13 | h >>> 19, h = H + ae | 0, Z ^= h << 18 | h >>> 14, h = A + v | 0, ce ^= h << 7 | h >>> 25, h = ce + A | 0, O ^= h << 9 | h >>> 23, h = O + ce | 0, v ^= h << 13 | h >>> 19, h = v + O | 0, A ^= h << 18 | h >>> 14, h = ie + S | 0, L ^= h << 7 | h >>> 25, h = L + ie | 0, b ^= h << 9 | h >>> 23, h = b + L | 0, S ^= h << 13 | h >>> 19, h = S + b | 0, ie ^= h << 18 | h >>> 14, h = j + L | 0, H ^= h << 7 | h >>> 25, h = H + j | 0, O ^= h << 9 | h >>> 23, h = O + H | 0, L ^= h << 13 | h >>> 19, h = L + O | 0, j ^= h << 18 | h >>> 14, h = Z + D | 0, v ^= h << 7 | h >>> 25, h = v + Z | 0, b ^= h << 9 | h >>> 23, h = b + v | 0, D ^= h << 13 | h >>> 19, h = D + b | 0, Z ^= h << 18 | h >>> 14, h = A + _ | 0, S ^= h << 7 | h >>> 25, h = S + A | 0, E ^= h << 9 | h >>> 23, h = E + S | 0, _ ^= h << 13 | h >>> 19, h = _ + E | 0, A ^= h << 18 | h >>> 14, h = ie + ce | 0, W ^= h << 7 | h >>> 25, h = W + ie | 0, ae ^= h << 9 | h >>> 23, h = ae + W | 0, ce ^= h << 13 | h >>> 19, h = ce + ae | 0, ie ^= h << 18 | h >>> 14;
          j = j + d | 0, H = H + y | 0, O = O + m | 0, L = L + w | 0, D = D + k | 0, Z = Z + $ | 0, v = v + R | 0, b = b + Ee | 0, E = E + U | 0, _ = _ + J | 0, A = A + Q | 0, S = S + se | 0, W = W + ne | 0, ae = ae + ee | 0, ce = ce + re | 0, ie = ie + te | 0, o[0] = j >>> 0 & 255, o[1] = j >>> 8 & 255, o[2] = j >>> 16 & 255, o[3] = j >>> 24 & 255, o[4] = H >>> 0 & 255, o[5] = H >>> 8 & 255, o[6] = H >>> 16 & 255, o[7] = H >>> 24 & 255, o[8] = O >>> 0 & 255, o[9] = O >>> 8 & 255, o[10] = O >>> 16 & 255, o[11] = O >>> 24 & 255, o[12] = L >>> 0 & 255, o[13] = L >>> 8 & 255, o[14] = L >>> 16 & 255, o[15] = L >>> 24 & 255, o[16] = D >>> 0 & 255, o[17] = D >>> 8 & 255, o[18] = D >>> 16 & 255, o[19] = D >>> 24 & 255, o[20] = Z >>> 0 & 255, o[21] = Z >>> 8 & 255, o[22] = Z >>> 16 & 255, o[23] = Z >>> 24 & 255, o[24] = v >>> 0 & 255, o[25] = v >>> 8 & 255, o[26] = v >>> 16 & 255, o[27] = v >>> 24 & 255, o[28] = b >>> 0 & 255, o[29] = b >>> 8 & 255, o[30] = b >>> 16 & 255, o[31] = b >>> 24 & 255, o[32] = E >>> 0 & 255, o[33] = E >>> 8 & 255, o[34] = E >>> 16 & 255, o[35] = E >>> 24 & 255, o[36] = _ >>> 0 & 255, o[37] = _ >>> 8 & 255, o[38] = _ >>> 16 & 255, o[39] = _ >>> 24 & 255, o[40] = A >>> 0 & 255, o[41] = A >>> 8 & 255, o[42] = A >>> 16 & 255, o[43] = A >>> 24 & 255, o[44] = S >>> 0 & 255, o[45] = S >>> 8 & 255, o[46] = S >>> 16 & 255, o[47] = S >>> 24 & 255, o[48] = W >>> 0 & 255, o[49] = W >>> 8 & 255, o[50] = W >>> 16 & 255, o[51] = W >>> 24 & 255, o[52] = ae >>> 0 & 255, o[53] = ae >>> 8 & 255, o[54] = ae >>> 16 & 255, o[55] = ae >>> 24 & 255, o[56] = ce >>> 0 & 255, o[57] = ce >>> 8 & 255, o[58] = ce >>> 16 & 255, o[59] = ce >>> 24 & 255, o[60] = ie >>> 0 & 255, o[61] = ie >>> 8 & 255, o[62] = ie >>> 16 & 255, o[63] = ie >>> 24 & 255;
        }
        function N(o, c, f, s) {
          for (var d = s[0] & 255 | (s[1] & 255) << 8 | (s[2] & 255) << 16 | (s[3] & 255) << 24, y = f[0] & 255 | (f[1] & 255) << 8 | (f[2] & 255) << 16 | (f[3] & 255) << 24, m = f[4] & 255 | (f[5] & 255) << 8 | (f[6] & 255) << 16 | (f[7] & 255) << 24, w = f[8] & 255 | (f[9] & 255) << 8 | (f[10] & 255) << 16 | (f[11] & 255) << 24, k = f[12] & 255 | (f[13] & 255) << 8 | (f[14] & 255) << 16 | (f[15] & 255) << 24, $ = s[4] & 255 | (s[5] & 255) << 8 | (s[6] & 255) << 16 | (s[7] & 255) << 24, R = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, Ee = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, U = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, J = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24, Q = s[8] & 255 | (s[9] & 255) << 8 | (s[10] & 255) << 16 | (s[11] & 255) << 24, se = f[16] & 255 | (f[17] & 255) << 8 | (f[18] & 255) << 16 | (f[19] & 255) << 24, ne = f[20] & 255 | (f[21] & 255) << 8 | (f[22] & 255) << 16 | (f[23] & 255) << 24, ee = f[24] & 255 | (f[25] & 255) << 8 | (f[26] & 255) << 16 | (f[27] & 255) << 24, re = f[28] & 255 | (f[29] & 255) << 8 | (f[30] & 255) << 16 | (f[31] & 255) << 24, te = s[12] & 255 | (s[13] & 255) << 8 | (s[14] & 255) << 16 | (s[15] & 255) << 24, j = d, H = y, O = m, L = w, D = k, Z = $, v = R, b = Ee, E = U, _ = J, A = Q, S = se, W = ne, ae = ee, ce = re, ie = te, h, pe = 0; pe < 20; pe += 2) h = j + W | 0, D ^= h << 7 | h >>> 25, h = D + j | 0, E ^= h << 9 | h >>> 23, h = E + D | 0, W ^= h << 13 | h >>> 19, h = W + E | 0, j ^= h << 18 | h >>> 14, h = Z + H | 0, _ ^= h << 7 | h >>> 25, h = _ + Z | 0, ae ^= h << 9 | h >>> 23, h = ae + _ | 0, H ^= h << 13 | h >>> 19, h = H + ae | 0, Z ^= h << 18 | h >>> 14, h = A + v | 0, ce ^= h << 7 | h >>> 25, h = ce + A | 0, O ^= h << 9 | h >>> 23, h = O + ce | 0, v ^= h << 13 | h >>> 19, h = v + O | 0, A ^= h << 18 | h >>> 14, h = ie + S | 0, L ^= h << 7 | h >>> 25, h = L + ie | 0, b ^= h << 9 | h >>> 23, h = b + L | 0, S ^= h << 13 | h >>> 19, h = S + b | 0, ie ^= h << 18 | h >>> 14, h = j + L | 0, H ^= h << 7 | h >>> 25, h = H + j | 0, O ^= h << 9 | h >>> 23, h = O + H | 0, L ^= h << 13 | h >>> 19, h = L + O | 0, j ^= h << 18 | h >>> 14, h = Z + D | 0, v ^= h << 7 | h >>> 25, h = v + Z | 0, b ^= h << 9 | h >>> 23, h = b + v | 0, D ^= h << 13 | h >>> 19, h = D + b | 0, Z ^= h << 18 | h >>> 14, h = A + _ | 0, S ^= h << 7 | h >>> 25, h = S + A | 0, E ^= h << 9 | h >>> 23, h = E + S | 0, _ ^= h << 13 | h >>> 19, h = _ + E | 0, A ^= h << 18 | h >>> 14, h = ie + ce | 0, W ^= h << 7 | h >>> 25, h = W + ie | 0, ae ^= h << 9 | h >>> 23, h = ae + W | 0, ce ^= h << 13 | h >>> 19, h = ce + ae | 0, ie ^= h << 18 | h >>> 14;
          o[0] = j >>> 0 & 255, o[1] = j >>> 8 & 255, o[2] = j >>> 16 & 255, o[3] = j >>> 24 & 255, o[4] = Z >>> 0 & 255, o[5] = Z >>> 8 & 255, o[6] = Z >>> 16 & 255, o[7] = Z >>> 24 & 255, o[8] = A >>> 0 & 255, o[9] = A >>> 8 & 255, o[10] = A >>> 16 & 255, o[11] = A >>> 24 & 255, o[12] = ie >>> 0 & 255, o[13] = ie >>> 8 & 255, o[14] = ie >>> 16 & 255, o[15] = ie >>> 24 & 255, o[16] = v >>> 0 & 255, o[17] = v >>> 8 & 255, o[18] = v >>> 16 & 255, o[19] = v >>> 24 & 255, o[20] = b >>> 0 & 255, o[21] = b >>> 8 & 255, o[22] = b >>> 16 & 255, o[23] = b >>> 24 & 255, o[24] = E >>> 0 & 255, o[25] = E >>> 8 & 255, o[26] = E >>> 16 & 255, o[27] = E >>> 24 & 255, o[28] = _ >>> 0 & 255, o[29] = _ >>> 8 & 255, o[30] = _ >>> 16 & 255, o[31] = _ >>> 24 & 255;
        }
        function ke(o, c, f, s) {
          ge(o, c, f, s);
        }
        function Oe(o, c, f, s) {
          N(o, c, f, s);
        }
        var Ce = new Uint8Array([
          101,
          120,
          112,
          97,
          110,
          100,
          32,
          51,
          50,
          45,
          98,
          121,
          116,
          101,
          32,
          107
        ]);
        function Fe(o, c, f, s, d, y, m) {
          var w = new Uint8Array(16), k = new Uint8Array(64), $, R;
          for (R = 0; R < 16; R++) w[R] = 0;
          for (R = 0; R < 8; R++) w[R] = y[R];
          for (; d >= 64; ) {
            for (ke(k, w, m, Ce), R = 0; R < 64; R++) o[c + R] = f[s + R] ^ k[R];
            for ($ = 1, R = 8; R < 16; R++) $ = $ + (w[R] & 255) | 0, w[R] = $ & 255, $ >>>= 8;
            d -= 64, c += 64, s += 64;
          }
          if (d > 0) for (ke(k, w, m, Ce), R = 0; R < d; R++) o[c + R] = f[s + R] ^ k[R];
          return 0;
        }
        function Ue(o, c, f, s, d) {
          var y = new Uint8Array(16), m = new Uint8Array(64), w, k;
          for (k = 0; k < 16; k++) y[k] = 0;
          for (k = 0; k < 8; k++) y[k] = s[k];
          for (; f >= 64; ) {
            for (ke(m, y, d, Ce), k = 0; k < 64; k++) o[c + k] = m[k];
            for (w = 1, k = 8; k < 16; k++) w = w + (y[k] & 255) | 0, y[k] = w & 255, w >>>= 8;
            f -= 64, c += 64;
          }
          if (f > 0) for (ke(m, y, d, Ce), k = 0; k < f; k++) o[c + k] = m[k];
          return 0;
        }
        function Ze(o, c, f, s, d) {
          var y = new Uint8Array(32);
          Oe(y, s, d, Ce);
          for (var m = new Uint8Array(8), w = 0; w < 8; w++) m[w] = s[w + 16];
          return Ue(o, c, f, m, y);
        }
        function We(o, c, f, s, d, y, m) {
          var w = new Uint8Array(32);
          Oe(w, y, m, Ce);
          for (var k = new Uint8Array(8), $ = 0; $ < 8; $++) k[$] = y[$ + 16];
          return Fe(o, c, f, s, d, k, w);
        }
        var Ne = function(o) {
          this.buffer = new Uint8Array(16), this.r = new Uint16Array(10), this.h = new Uint16Array(10), this.pad = new Uint16Array(8), this.leftover = 0, this.fin = 0;
          var c, f, s, d, y, m, w, k;
          c = o[0] & 255 | (o[1] & 255) << 8, this.r[0] = c & 8191, f = o[2] & 255 | (o[3] & 255) << 8, this.r[1] = (c >>> 13 | f << 3) & 8191, s = o[4] & 255 | (o[5] & 255) << 8, this.r[2] = (f >>> 10 | s << 6) & 7939, d = o[6] & 255 | (o[7] & 255) << 8, this.r[3] = (s >>> 7 | d << 9) & 8191, y = o[8] & 255 | (o[9] & 255) << 8, this.r[4] = (d >>> 4 | y << 12) & 255, this.r[5] = y >>> 1 & 8190, m = o[10] & 255 | (o[11] & 255) << 8, this.r[6] = (y >>> 14 | m << 2) & 8191, w = o[12] & 255 | (o[13] & 255) << 8, this.r[7] = (m >>> 11 | w << 5) & 8065, k = o[14] & 255 | (o[15] & 255) << 8, this.r[8] = (w >>> 8 | k << 8) & 8191, this.r[9] = k >>> 5 & 127, this.pad[0] = o[16] & 255 | (o[17] & 255) << 8, this.pad[1] = o[18] & 255 | (o[19] & 255) << 8, this.pad[2] = o[20] & 255 | (o[21] & 255) << 8, this.pad[3] = o[22] & 255 | (o[23] & 255) << 8, this.pad[4] = o[24] & 255 | (o[25] & 255) << 8, this.pad[5] = o[26] & 255 | (o[27] & 255) << 8, this.pad[6] = o[28] & 255 | (o[29] & 255) << 8, this.pad[7] = o[30] & 255 | (o[31] & 255) << 8;
        };
        Ne.prototype.blocks = function(o, c, f) {
          for (var s = this.fin ? 0 : 2048, d, y, m, w, k, $, R, Ee, U, J, Q, se, ne, ee, re, te, j, H, O, L = this.h[0], D = this.h[1], Z = this.h[2], v = this.h[3], b = this.h[4], E = this.h[5], _ = this.h[6], A = this.h[7], S = this.h[8], W = this.h[9], ae = this.r[0], ce = this.r[1], ie = this.r[2], h = this.r[3], pe = this.r[4], Se = this.r[5], Te = this.r[6], ue = this.r[7], _e = this.r[8], we = this.r[9]; f >= 16; ) d = o[c + 0] & 255 | (o[c + 1] & 255) << 8, L += d & 8191, y = o[c + 2] & 255 | (o[c + 3] & 255) << 8, D += (d >>> 13 | y << 3) & 8191, m = o[c + 4] & 255 | (o[c + 5] & 255) << 8, Z += (y >>> 10 | m << 6) & 8191, w = o[c + 6] & 255 | (o[c + 7] & 255) << 8, v += (m >>> 7 | w << 9) & 8191, k = o[c + 8] & 255 | (o[c + 9] & 255) << 8, b += (w >>> 4 | k << 12) & 8191, E += k >>> 1 & 8191, $ = o[c + 10] & 255 | (o[c + 11] & 255) << 8, _ += (k >>> 14 | $ << 2) & 8191, R = o[c + 12] & 255 | (o[c + 13] & 255) << 8, A += ($ >>> 11 | R << 5) & 8191, Ee = o[c + 14] & 255 | (o[c + 15] & 255) << 8, S += (R >>> 8 | Ee << 8) & 8191, W += Ee >>> 5 | s, U = 0, J = U, J += L * ae, J += D * (5 * we), J += Z * (5 * _e), J += v * (5 * ue), J += b * (5 * Te), U = J >>> 13, J &= 8191, J += E * (5 * Se), J += _ * (5 * pe), J += A * (5 * h), J += S * (5 * ie), J += W * (5 * ce), U += J >>> 13, J &= 8191, Q = U, Q += L * ce, Q += D * ae, Q += Z * (5 * we), Q += v * (5 * _e), Q += b * (5 * ue), U = Q >>> 13, Q &= 8191, Q += E * (5 * Te), Q += _ * (5 * Se), Q += A * (5 * pe), Q += S * (5 * h), Q += W * (5 * ie), U += Q >>> 13, Q &= 8191, se = U, se += L * ie, se += D * ce, se += Z * ae, se += v * (5 * we), se += b * (5 * _e), U = se >>> 13, se &= 8191, se += E * (5 * ue), se += _ * (5 * Te), se += A * (5 * Se), se += S * (5 * pe), se += W * (5 * h), U += se >>> 13, se &= 8191, ne = U, ne += L * h, ne += D * ie, ne += Z * ce, ne += v * ae, ne += b * (5 * we), U = ne >>> 13, ne &= 8191, ne += E * (5 * _e), ne += _ * (5 * ue), ne += A * (5 * Te), ne += S * (5 * Se), ne += W * (5 * pe), U += ne >>> 13, ne &= 8191, ee = U, ee += L * pe, ee += D * h, ee += Z * ie, ee += v * ce, ee += b * ae, U = ee >>> 13, ee &= 8191, ee += E * (5 * we), ee += _ * (5 * _e), ee += A * (5 * ue), ee += S * (5 * Te), ee += W * (5 * Se), U += ee >>> 13, ee &= 8191, re = U, re += L * Se, re += D * pe, re += Z * h, re += v * ie, re += b * ce, U = re >>> 13, re &= 8191, re += E * ae, re += _ * (5 * we), re += A * (5 * _e), re += S * (5 * ue), re += W * (5 * Te), U += re >>> 13, re &= 8191, te = U, te += L * Te, te += D * Se, te += Z * pe, te += v * h, te += b * ie, U = te >>> 13, te &= 8191, te += E * ce, te += _ * ae, te += A * (5 * we), te += S * (5 * _e), te += W * (5 * ue), U += te >>> 13, te &= 8191, j = U, j += L * ue, j += D * Te, j += Z * Se, j += v * pe, j += b * h, U = j >>> 13, j &= 8191, j += E * ie, j += _ * ce, j += A * ae, j += S * (5 * we), j += W * (5 * _e), U += j >>> 13, j &= 8191, H = U, H += L * _e, H += D * ue, H += Z * Te, H += v * Se, H += b * pe, U = H >>> 13, H &= 8191, H += E * h, H += _ * ie, H += A * ce, H += S * ae, H += W * (5 * we), U += H >>> 13, H &= 8191, O = U, O += L * we, O += D * _e, O += Z * ue, O += v * Te, O += b * Se, U = O >>> 13, O &= 8191, O += E * pe, O += _ * h, O += A * ie, O += S * ce, O += W * ae, U += O >>> 13, O &= 8191, U = (U << 2) + U | 0, U = U + J | 0, J = U & 8191, U = U >>> 13, Q += U, L = J, D = Q, Z = se, v = ne, b = ee, E = re, _ = te, A = j, S = H, W = O, c += 16, f -= 16;
          this.h[0] = L, this.h[1] = D, this.h[2] = Z, this.h[3] = v, this.h[4] = b, this.h[5] = E, this.h[6] = _, this.h[7] = A, this.h[8] = S, this.h[9] = W;
        }, Ne.prototype.finish = function(o, c) {
          var f = new Uint16Array(10), s, d, y, m;
          if (this.leftover) {
            for (m = this.leftover, this.buffer[m++] = 1; m < 16; m++) this.buffer[m] = 0;
            this.fin = 1, this.blocks(this.buffer, 0, 16);
          }
          for (s = this.h[1] >>> 13, this.h[1] &= 8191, m = 2; m < 10; m++) this.h[m] += s, s = this.h[m] >>> 13, this.h[m] &= 8191;
          for (this.h[0] += s * 5, s = this.h[0] >>> 13, this.h[0] &= 8191, this.h[1] += s, s = this.h[1] >>> 13, this.h[1] &= 8191, this.h[2] += s, f[0] = this.h[0] + 5, s = f[0] >>> 13, f[0] &= 8191, m = 1; m < 10; m++) f[m] = this.h[m] + s, s = f[m] >>> 13, f[m] &= 8191;
          for (f[9] -= 8192, d = (s ^ 1) - 1, m = 0; m < 10; m++) f[m] &= d;
          for (d = ~d, m = 0; m < 10; m++) this.h[m] = this.h[m] & d | f[m];
          for (this.h[0] = (this.h[0] | this.h[1] << 13) & 65535, this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535, this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535, this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535, this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535, this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535, this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535, this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535, y = this.h[0] + this.pad[0], this.h[0] = y & 65535, m = 1; m < 8; m++) y = (this.h[m] + this.pad[m] | 0) + (y >>> 16) | 0, this.h[m] = y & 65535;
          o[c + 0] = this.h[0] >>> 0 & 255, o[c + 1] = this.h[0] >>> 8 & 255, o[c + 2] = this.h[1] >>> 0 & 255, o[c + 3] = this.h[1] >>> 8 & 255, o[c + 4] = this.h[2] >>> 0 & 255, o[c + 5] = this.h[2] >>> 8 & 255, o[c + 6] = this.h[3] >>> 0 & 255, o[c + 7] = this.h[3] >>> 8 & 255, o[c + 8] = this.h[4] >>> 0 & 255, o[c + 9] = this.h[4] >>> 8 & 255, o[c + 10] = this.h[5] >>> 0 & 255, o[c + 11] = this.h[5] >>> 8 & 255, o[c + 12] = this.h[6] >>> 0 & 255, o[c + 13] = this.h[6] >>> 8 & 255, o[c + 14] = this.h[7] >>> 0 & 255, o[c + 15] = this.h[7] >>> 8 & 255;
        }, Ne.prototype.update = function(o, c, f) {
          var s, d;
          if (this.leftover) {
            for (d = 16 - this.leftover, d > f && (d = f), s = 0; s < d; s++) this.buffer[this.leftover + s] = o[c + s];
            if (f -= d, c += d, this.leftover += d, this.leftover < 16) return;
            this.blocks(this.buffer, 0, 16), this.leftover = 0;
          }
          if (f >= 16 && (d = f - f % 16, this.blocks(o, c, d), c += d, f -= d), f) {
            for (s = 0; s < f; s++) this.buffer[this.leftover + s] = o[c + s];
            this.leftover += f;
          }
        };
        function ct(o, c, f, s, d, y) {
          var m = new Ne(y);
          return m.update(f, s, d), m.finish(o, c), 0;
        }
        function dt(o, c, f, s, d, y) {
          var m = new Uint8Array(16);
          return ct(m, 0, f, s, d, y), Me(o, c, m, 0);
        }
        function _t(o, c, f, s, d) {
          var y;
          if (f < 32) return -1;
          for (We(o, 0, c, 0, f, s, d), ct(o, 16, o, 32, f - 32, o), y = 0; y < 16; y++) o[y] = 0;
          return 0;
        }
        function lt(o, c, f, s, d) {
          var y, m = new Uint8Array(32);
          if (f < 32 || (Ze(m, 0, 32, s, d), dt(c, 16, c, 32, f - 32, m) !== 0)) return -1;
          for (We(o, 0, c, 0, f, s, d), y = 0; y < 32; y++) o[y] = 0;
          return 0;
        }
        function q(o, c) {
          var f;
          for (f = 0; f < 16; f++) o[f] = c[f] | 0;
        }
        function B(o) {
          var c, f, s = 1;
          for (c = 0; c < 16; c++) f = o[c] + s + 65535, s = Math.floor(f / 65536), o[c] = f - s * 65536;
          o[0] += s - 1 + 37 * (s - 1);
        }
        function V(o, c, f) {
          for (var s, d = ~(f - 1), y = 0; y < 16; y++) s = d & (o[y] ^ c[y]), o[y] ^= s, c[y] ^= s;
        }
        function G(o, c) {
          var f, s, d, y = t(), m = t();
          for (f = 0; f < 16; f++) m[f] = c[f];
          for (B(m), B(m), B(m), s = 0; s < 2; s++) {
            for (y[0] = m[0] - 65517, f = 1; f < 15; f++) y[f] = m[f] - 65535 - (y[f - 1] >> 16 & 1), y[f - 1] &= 65535;
            y[15] = m[15] - 32767 - (y[14] >> 16 & 1), d = y[15] >> 16 & 1, y[14] &= 65535, V(m, y, 1 - d);
          }
          for (f = 0; f < 16; f++) o[2 * f] = m[f] & 255, o[2 * f + 1] = m[f] >> 8;
        }
        function ye(o, c) {
          var f = new Uint8Array(32), s = new Uint8Array(32);
          return G(f, o), G(s, c), Ge(f, 0, s, 0);
        }
        function ve(o) {
          var c = new Uint8Array(32);
          return G(c, o), c[0] & 1;
        }
        function be(o, c) {
          var f;
          for (f = 0; f < 16; f++) o[f] = c[2 * f] + (c[2 * f + 1] << 8);
          o[15] &= 32767;
        }
        function me(o, c, f) {
          for (var s = 0; s < 16; s++) o[s] = c[s] + f[s];
        }
        function fe(o, c, f) {
          for (var s = 0; s < 16; s++) o[s] = c[s] - f[s];
        }
        function z(o, c, f) {
          var s, d, y = 0, m = 0, w = 0, k = 0, $ = 0, R = 0, Ee = 0, U = 0, J = 0, Q = 0, se = 0, ne = 0, ee = 0, re = 0, te = 0, j = 0, H = 0, O = 0, L = 0, D = 0, Z = 0, v = 0, b = 0, E = 0, _ = 0, A = 0, S = 0, W = 0, ae = 0, ce = 0, ie = 0, h = f[0], pe = f[1], Se = f[2], Te = f[3], ue = f[4], _e = f[5], we = f[6], $e = f[7], Ie = f[8], Le = f[9], De = f[10], ze = f[11], Ye = f[12], Je = f[13], Qe = f[14], et = f[15];
          s = c[0], y += s * h, m += s * pe, w += s * Se, k += s * Te, $ += s * ue, R += s * _e, Ee += s * we, U += s * $e, J += s * Ie, Q += s * Le, se += s * De, ne += s * ze, ee += s * Ye, re += s * Je, te += s * Qe, j += s * et, s = c[1], m += s * h, w += s * pe, k += s * Se, $ += s * Te, R += s * ue, Ee += s * _e, U += s * we, J += s * $e, Q += s * Ie, se += s * Le, ne += s * De, ee += s * ze, re += s * Ye, te += s * Je, j += s * Qe, H += s * et, s = c[2], w += s * h, k += s * pe, $ += s * Se, R += s * Te, Ee += s * ue, U += s * _e, J += s * we, Q += s * $e, se += s * Ie, ne += s * Le, ee += s * De, re += s * ze, te += s * Ye, j += s * Je, H += s * Qe, O += s * et, s = c[3], k += s * h, $ += s * pe, R += s * Se, Ee += s * Te, U += s * ue, J += s * _e, Q += s * we, se += s * $e, ne += s * Ie, ee += s * Le, re += s * De, te += s * ze, j += s * Ye, H += s * Je, O += s * Qe, L += s * et, s = c[4], $ += s * h, R += s * pe, Ee += s * Se, U += s * Te, J += s * ue, Q += s * _e, se += s * we, ne += s * $e, ee += s * Ie, re += s * Le, te += s * De, j += s * ze, H += s * Ye, O += s * Je, L += s * Qe, D += s * et, s = c[5], R += s * h, Ee += s * pe, U += s * Se, J += s * Te, Q += s * ue, se += s * _e, ne += s * we, ee += s * $e, re += s * Ie, te += s * Le, j += s * De, H += s * ze, O += s * Ye, L += s * Je, D += s * Qe, Z += s * et, s = c[6], Ee += s * h, U += s * pe, J += s * Se, Q += s * Te, se += s * ue, ne += s * _e, ee += s * we, re += s * $e, te += s * Ie, j += s * Le, H += s * De, O += s * ze, L += s * Ye, D += s * Je, Z += s * Qe, v += s * et, s = c[7], U += s * h, J += s * pe, Q += s * Se, se += s * Te, ne += s * ue, ee += s * _e, re += s * we, te += s * $e, j += s * Ie, H += s * Le, O += s * De, L += s * ze, D += s * Ye, Z += s * Je, v += s * Qe, b += s * et, s = c[8], J += s * h, Q += s * pe, se += s * Se, ne += s * Te, ee += s * ue, re += s * _e, te += s * we, j += s * $e, H += s * Ie, O += s * Le, L += s * De, D += s * ze, Z += s * Ye, v += s * Je, b += s * Qe, E += s * et, s = c[9], Q += s * h, se += s * pe, ne += s * Se, ee += s * Te, re += s * ue, te += s * _e, j += s * we, H += s * $e, O += s * Ie, L += s * Le, D += s * De, Z += s * ze, v += s * Ye, b += s * Je, E += s * Qe, _ += s * et, s = c[10], se += s * h, ne += s * pe, ee += s * Se, re += s * Te, te += s * ue, j += s * _e, H += s * we, O += s * $e, L += s * Ie, D += s * Le, Z += s * De, v += s * ze, b += s * Ye, E += s * Je, _ += s * Qe, A += s * et, s = c[11], ne += s * h, ee += s * pe, re += s * Se, te += s * Te, j += s * ue, H += s * _e, O += s * we, L += s * $e, D += s * Ie, Z += s * Le, v += s * De, b += s * ze, E += s * Ye, _ += s * Je, A += s * Qe, S += s * et, s = c[12], ee += s * h, re += s * pe, te += s * Se, j += s * Te, H += s * ue, O += s * _e, L += s * we, D += s * $e, Z += s * Ie, v += s * Le, b += s * De, E += s * ze, _ += s * Ye, A += s * Je, S += s * Qe, W += s * et, s = c[13], re += s * h, te += s * pe, j += s * Se, H += s * Te, O += s * ue, L += s * _e, D += s * we, Z += s * $e, v += s * Ie, b += s * Le, E += s * De, _ += s * ze, A += s * Ye, S += s * Je, W += s * Qe, ae += s * et, s = c[14], te += s * h, j += s * pe, H += s * Se, O += s * Te, L += s * ue, D += s * _e, Z += s * we, v += s * $e, b += s * Ie, E += s * Le, _ += s * De, A += s * ze, S += s * Ye, W += s * Je, ae += s * Qe, ce += s * et, s = c[15], j += s * h, H += s * pe, O += s * Se, L += s * Te, D += s * ue, Z += s * _e, v += s * we, b += s * $e, E += s * Ie, _ += s * Le, A += s * De, S += s * ze, W += s * Ye, ae += s * Je, ce += s * Qe, ie += s * et, y += 38 * H, m += 38 * O, w += 38 * L, k += 38 * D, $ += 38 * Z, R += 38 * v, Ee += 38 * b, U += 38 * E, J += 38 * _, Q += 38 * A, se += 38 * S, ne += 38 * W, ee += 38 * ae, re += 38 * ce, te += 38 * ie, d = 1, s = y + d + 65535, d = Math.floor(s / 65536), y = s - d * 65536, s = m + d + 65535, d = Math.floor(s / 65536), m = s - d * 65536, s = w + d + 65535, d = Math.floor(s / 65536), w = s - d * 65536, s = k + d + 65535, d = Math.floor(s / 65536), k = s - d * 65536, s = $ + d + 65535, d = Math.floor(s / 65536), $ = s - d * 65536, s = R + d + 65535, d = Math.floor(s / 65536), R = s - d * 65536, s = Ee + d + 65535, d = Math.floor(s / 65536), Ee = s - d * 65536, s = U + d + 65535, d = Math.floor(s / 65536), U = s - d * 65536, s = J + d + 65535, d = Math.floor(s / 65536), J = s - d * 65536, s = Q + d + 65535, d = Math.floor(s / 65536), Q = s - d * 65536, s = se + d + 65535, d = Math.floor(s / 65536), se = s - d * 65536, s = ne + d + 65535, d = Math.floor(s / 65536), ne = s - d * 65536, s = ee + d + 65535, d = Math.floor(s / 65536), ee = s - d * 65536, s = re + d + 65535, d = Math.floor(s / 65536), re = s - d * 65536, s = te + d + 65535, d = Math.floor(s / 65536), te = s - d * 65536, s = j + d + 65535, d = Math.floor(s / 65536), j = s - d * 65536, y += d - 1 + 37 * (d - 1), d = 1, s = y + d + 65535, d = Math.floor(s / 65536), y = s - d * 65536, s = m + d + 65535, d = Math.floor(s / 65536), m = s - d * 65536, s = w + d + 65535, d = Math.floor(s / 65536), w = s - d * 65536, s = k + d + 65535, d = Math.floor(s / 65536), k = s - d * 65536, s = $ + d + 65535, d = Math.floor(s / 65536), $ = s - d * 65536, s = R + d + 65535, d = Math.floor(s / 65536), R = s - d * 65536, s = Ee + d + 65535, d = Math.floor(s / 65536), Ee = s - d * 65536, s = U + d + 65535, d = Math.floor(s / 65536), U = s - d * 65536, s = J + d + 65535, d = Math.floor(s / 65536), J = s - d * 65536, s = Q + d + 65535, d = Math.floor(s / 65536), Q = s - d * 65536, s = se + d + 65535, d = Math.floor(s / 65536), se = s - d * 65536, s = ne + d + 65535, d = Math.floor(s / 65536), ne = s - d * 65536, s = ee + d + 65535, d = Math.floor(s / 65536), ee = s - d * 65536, s = re + d + 65535, d = Math.floor(s / 65536), re = s - d * 65536, s = te + d + 65535, d = Math.floor(s / 65536), te = s - d * 65536, s = j + d + 65535, d = Math.floor(s / 65536), j = s - d * 65536, y += d - 1 + 37 * (d - 1), o[0] = y, o[1] = m, o[2] = w, o[3] = k, o[4] = $, o[5] = R, o[6] = Ee, o[7] = U, o[8] = J, o[9] = Q, o[10] = se, o[11] = ne, o[12] = ee, o[13] = re, o[14] = te, o[15] = j;
        }
        function Be(o, c) {
          z(o, c, c);
        }
        function Ke(o, c) {
          var f = t(), s;
          for (s = 0; s < 16; s++) f[s] = c[s];
          for (s = 253; s >= 0; s--) Be(f, f), s !== 2 && s !== 4 && z(f, f, c);
          for (s = 0; s < 16; s++) o[s] = f[s];
        }
        function it(o, c) {
          var f = t(), s;
          for (s = 0; s < 16; s++) f[s] = c[s];
          for (s = 250; s >= 0; s--) Be(f, f), s !== 1 && z(f, f, c);
          for (s = 0; s < 16; s++) o[s] = f[s];
        }
        function rt(o, c, f) {
          var s = new Uint8Array(32), d = new Float64Array(80), y, m, w = t(), k = t(), $ = t(), R = t(), Ee = t(), U = t();
          for (m = 0; m < 31; m++) s[m] = c[m];
          for (s[31] = c[31] & 127 | 64, s[0] &= 248, be(d, f), m = 0; m < 16; m++) k[m] = d[m], R[m] = w[m] = $[m] = 0;
          for (w[0] = R[0] = 1, m = 254; m >= 0; --m) y = s[m >>> 3] >>> (m & 7) & 1, V(w, k, y), V($, R, y), me(Ee, w, $), fe(w, w, $), me($, k, R), fe(k, k, R), Be(R, Ee), Be(U, w), z(w, $, w), z($, k, Ee), me(Ee, w, $), fe(w, w, $), Be(k, w), fe($, R, U), z(w, $, x), me(w, w, R), z($, $, w), z(w, R, U), z(R, k, d), Be(k, Ee), V(w, k, y), V($, R, y);
          for (m = 0; m < 16; m++) d[m + 16] = w[m], d[m + 32] = $[m], d[m + 48] = k[m], d[m + 64] = R[m];
          var J = d.subarray(32), Q = d.subarray(16);
          return Ke(J, J), z(Q, Q, J), G(o, Q), 0;
        }
        function Xe(o, c) {
          return rt(o, c, i);
        }
        function ht(o, c) {
          return n(c, 32), Xe(o, c);
        }
        function ut(o, c, f) {
          var s = new Uint8Array(32);
          return rt(s, f, c), Oe(o, a, s, Ce);
        }
        var jt = _t, jr = lt;
        function Lr(o, c, f, s, d, y) {
          var m = new Uint8Array(32);
          return ut(m, d, y), jt(o, c, f, s, m);
        }
        function sn(o, c, f, s, d, y) {
          var m = new Uint8Array(32);
          return ut(m, d, y), jr(o, c, f, s, m);
        }
        var Dr = [
          1116352408,
          3609767458,
          1899447441,
          602891725,
          3049323471,
          3964484399,
          3921009573,
          2173295548,
          961987163,
          4081628472,
          1508970993,
          3053834265,
          2453635748,
          2937671579,
          2870763221,
          3664609560,
          3624381080,
          2734883394,
          310598401,
          1164996542,
          607225278,
          1323610764,
          1426881987,
          3590304994,
          1925078388,
          4068182383,
          2162078206,
          991336113,
          2614888103,
          633803317,
          3248222580,
          3479774868,
          3835390401,
          2666613458,
          4022224774,
          944711139,
          264347078,
          2341262773,
          604807628,
          2007800933,
          770255983,
          1495990901,
          1249150122,
          1856431235,
          1555081692,
          3175218132,
          1996064986,
          2198950837,
          2554220882,
          3999719339,
          2821834349,
          766784016,
          2952996808,
          2566594879,
          3210313671,
          3203337956,
          3336571891,
          1034457026,
          3584528711,
          2466948901,
          113926993,
          3758326383,
          338241895,
          168717936,
          666307205,
          1188179964,
          773529912,
          1546045734,
          1294757372,
          1522805485,
          1396182291,
          2643833823,
          1695183700,
          2343527390,
          1986661051,
          1014477480,
          2177026350,
          1206759142,
          2456956037,
          344077627,
          2730485921,
          1290863460,
          2820302411,
          3158454273,
          3259730800,
          3505952657,
          3345764771,
          106217008,
          3516065817,
          3606008344,
          3600352804,
          1432725776,
          4094571909,
          1467031594,
          275423344,
          851169720,
          430227734,
          3100823752,
          506948616,
          1363258195,
          659060556,
          3750685593,
          883997877,
          3785050280,
          958139571,
          3318307427,
          1322822218,
          3812723403,
          1537002063,
          2003034995,
          1747873779,
          3602036899,
          1955562222,
          1575990012,
          2024104815,
          1125592928,
          2227730452,
          2716904306,
          2361852424,
          442776044,
          2428436474,
          593698344,
          2756734187,
          3733110249,
          3204031479,
          2999351573,
          3329325298,
          3815920427,
          3391569614,
          3928383900,
          3515267271,
          566280711,
          3940187606,
          3454069534,
          4118630271,
          4000239992,
          116418474,
          1914138554,
          174292421,
          2731055270,
          289380356,
          3203993006,
          460393269,
          320620315,
          685471733,
          587496836,
          852142971,
          1086792851,
          1017036298,
          365543100,
          1126000580,
          2618297676,
          1288033470,
          3409855158,
          1501505948,
          4234509866,
          1607167915,
          987167468,
          1816402316,
          1246189591
        ];
        function zr(o, c, f, s) {
          for (var d = new Int32Array(16), y = new Int32Array(16), m, w, k, $, R, Ee, U, J, Q, se, ne, ee, re, te, j, H, O, L, D, Z, v, b, E, _, A, S, W = o[0], ae = o[1], ce = o[2], ie = o[3], h = o[4], pe = o[5], Se = o[6], Te = o[7], ue = c[0], _e = c[1], we = c[2], $e = c[3], Ie = c[4], Le = c[5], De = c[6], ze = c[7], Ye = 0; s >= 128; ) {
            for (D = 0; D < 16; D++) Z = 8 * D + Ye, d[D] = f[Z + 0] << 24 | f[Z + 1] << 16 | f[Z + 2] << 8 | f[Z + 3], y[D] = f[Z + 4] << 24 | f[Z + 5] << 16 | f[Z + 6] << 8 | f[Z + 7];
            for (D = 0; D < 80; D++) if (m = W, w = ae, k = ce, $ = ie, R = h, Ee = pe, U = Se, J = Te, Q = ue, se = _e, ne = we, ee = $e, re = Ie, te = Le, j = De, H = ze, v = Te, b = ze, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = (h >>> 14 | Ie << 18) ^ (h >>> 18 | Ie << 14) ^ (Ie >>> 9 | h << 23), b = (Ie >>> 14 | h << 18) ^ (Ie >>> 18 | h << 14) ^ (h >>> 9 | Ie << 23), E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, v = h & pe ^ ~h & Se, b = Ie & Le ^ ~Ie & De, E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, v = Dr[D * 2], b = Dr[D * 2 + 1], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, v = d[D % 16], b = y[D % 16], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, O = A & 65535 | S << 16, L = E & 65535 | _ << 16, v = O, b = L, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = (W >>> 28 | ue << 4) ^ (ue >>> 2 | W << 30) ^ (ue >>> 7 | W << 25), b = (ue >>> 28 | W << 4) ^ (W >>> 2 | ue << 30) ^ (W >>> 7 | ue << 25), E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, v = W & ae ^ W & ce ^ ae & ce, b = ue & _e ^ ue & we ^ _e & we, E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, J = A & 65535 | S << 16, H = E & 65535 | _ << 16, v = $, b = ee, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = O, b = L, E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, $ = A & 65535 | S << 16, ee = E & 65535 | _ << 16, ae = m, ce = w, ie = k, h = $, pe = R, Se = Ee, Te = U, W = J, _e = Q, we = se, $e = ne, Ie = ee, Le = re, De = te, ze = j, ue = H, D % 16 === 15) for (Z = 0; Z < 16; Z++) v = d[Z], b = y[Z], E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = d[(Z + 9) % 16], b = y[(Z + 9) % 16], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, O = d[(Z + 1) % 16], L = y[(Z + 1) % 16], v = (O >>> 1 | L << 31) ^ (O >>> 8 | L << 24) ^ O >>> 7, b = (L >>> 1 | O << 31) ^ (L >>> 8 | O << 24) ^ (L >>> 7 | O << 25), E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, O = d[(Z + 14) % 16], L = y[(Z + 14) % 16], v = (O >>> 19 | L << 13) ^ (L >>> 29 | O << 3) ^ O >>> 6, b = (L >>> 19 | O << 13) ^ (O >>> 29 | L << 3) ^ (L >>> 6 | O << 26), E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, d[Z] = A & 65535 | S << 16, y[Z] = E & 65535 | _ << 16;
            v = W, b = ue, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[0], b = c[0], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[0] = W = A & 65535 | S << 16, c[0] = ue = E & 65535 | _ << 16, v = ae, b = _e, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[1], b = c[1], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[1] = ae = A & 65535 | S << 16, c[1] = _e = E & 65535 | _ << 16, v = ce, b = we, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[2], b = c[2], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[2] = ce = A & 65535 | S << 16, c[2] = we = E & 65535 | _ << 16, v = ie, b = $e, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[3], b = c[3], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[3] = ie = A & 65535 | S << 16, c[3] = $e = E & 65535 | _ << 16, v = h, b = Ie, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[4], b = c[4], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[4] = h = A & 65535 | S << 16, c[4] = Ie = E & 65535 | _ << 16, v = pe, b = Le, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[5], b = c[5], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[5] = pe = A & 65535 | S << 16, c[5] = Le = E & 65535 | _ << 16, v = Se, b = De, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[6], b = c[6], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[6] = Se = A & 65535 | S << 16, c[6] = De = E & 65535 | _ << 16, v = Te, b = ze, E = b & 65535, _ = b >>> 16, A = v & 65535, S = v >>> 16, v = o[7], b = c[7], E += b & 65535, _ += b >>> 16, A += v & 65535, S += v >>> 16, _ += E >>> 16, A += _ >>> 16, S += A >>> 16, o[7] = Te = A & 65535 | S << 16, c[7] = ze = E & 65535 | _ << 16, Ye += 128, s -= 128;
          }
          return s;
        }
        function St(o, c, f) {
          var s = new Int32Array(8), d = new Int32Array(8), y = new Uint8Array(256), m, w = f;
          for (s[0] = 1779033703, s[1] = 3144134277, s[2] = 1013904242, s[3] = 2773480762, s[4] = 1359893119, s[5] = 2600822924, s[6] = 528734635, s[7] = 1541459225, d[0] = 4089235720, d[1] = 2227873595, d[2] = 4271175723, d[3] = 1595750129, d[4] = 2917565137, d[5] = 725511199, d[6] = 4215389547, d[7] = 327033209, zr(s, d, c, f), f %= 128, m = 0; m < f; m++) y[m] = c[w - f + m];
          for (y[f] = 128, f = 256 - 128 * (f < 112 ? 1 : 0), y[f - 9] = 0, de(y, f - 8, w / 536870912 | 0, w << 3), zr(s, d, y, f), m = 0; m < 8; m++) de(o, 8 * m, s[m], d[m]);
          return 0;
        }
        function Lt(o, c) {
          var f = t(), s = t(), d = t(), y = t(), m = t(), w = t(), k = t(), $ = t(), R = t();
          fe(f, o[1], o[0]), fe(R, c[1], c[0]), z(f, f, R), me(s, o[0], o[1]), me(R, c[0], c[1]), z(s, s, R), z(d, o[3], c[3]), z(d, d, g), z(y, o[2], c[2]), me(y, y, y), fe(m, s, f), fe(w, y, d), me(k, y, d), me($, s, f), z(o[0], m, w), z(o[1], $, k), z(o[2], k, w), z(o[3], m, $);
        }
        function ur(o, c, f) {
          var s;
          for (s = 0; s < 4; s++) V(o[s], c[s], f);
        }
        function Dt(o, c) {
          var f = t(), s = t(), d = t();
          Ke(d, c[2]), z(f, c[0], d), z(s, c[1], d), G(o, s), o[31] ^= ve(f) << 7;
        }
        function Wt(o, c, f) {
          var s, d;
          for (q(o[0], u), q(o[1], l), q(o[2], l), q(o[3], u), d = 255; d >= 0; --d) s = f[d / 8 | 0] >> (d & 7) & 1, ur(o, c, s), Lt(c, o), Lt(o, o), ur(o, c, s);
        }
        function zt(o, c) {
          var f = [
            t(),
            t(),
            t(),
            t()
          ];
          q(f[0], I), q(f[1], Y), q(f[2], l), z(f[3], I, Y), Wt(o, f, c);
        }
        function Kt(o, c, f) {
          var s = new Uint8Array(64), d = [
            t(),
            t(),
            t(),
            t()
          ], y;
          for (f || n(c, 32), St(s, c, 32), s[0] &= 248, s[31] &= 127, s[31] |= 64, zt(d, s), Dt(o, d), y = 0; y < 32; y++) c[y + 32] = o[y];
          return 0;
        }
        var $t = new Float64Array([
          237,
          211,
          245,
          92,
          26,
          99,
          18,
          88,
          214,
          156,
          247,
          162,
          222,
          249,
          222,
          20,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          16
        ]);
        function Xt(o, c) {
          var f, s, d, y;
          for (s = 63; s >= 32; --s) {
            for (f = 0, d = s - 32, y = s - 12; d < y; ++d) c[d] += f - 16 * c[s] * $t[d - (s - 32)], f = Math.floor((c[d] + 128) / 256), c[d] -= f * 256;
            c[d] += f, c[s] = 0;
          }
          for (f = 0, d = 0; d < 32; d++) c[d] += f - (c[31] >> 4) * $t[d], f = c[d] >> 8, c[d] &= 255;
          for (d = 0; d < 32; d++) c[d] -= f * $t[d];
          for (s = 0; s < 32; s++) c[s + 1] += c[s] >> 8, o[s] = c[s] & 255;
        }
        function lr(o) {
          var c = new Float64Array(64), f;
          for (f = 0; f < 64; f++) c[f] = o[f];
          for (f = 0; f < 64; f++) o[f] = 0;
          Xt(o, c);
        }
        function $r(o, c, f, s) {
          var d = new Uint8Array(64), y = new Uint8Array(64), m = new Uint8Array(64), w, k, $ = new Float64Array(64), R = [
            t(),
            t(),
            t(),
            t()
          ];
          St(d, s, 32), d[0] &= 248, d[31] &= 127, d[31] |= 64;
          var Ee = f + 64;
          for (w = 0; w < f; w++) o[64 + w] = c[w];
          for (w = 0; w < 32; w++) o[32 + w] = d[32 + w];
          for (St(m, o.subarray(32), f + 32), lr(m), zt(R, m), Dt(o, R), w = 32; w < 64; w++) o[w] = s[w];
          for (St(y, o, f + 64), lr(y), w = 0; w < 64; w++) $[w] = 0;
          for (w = 0; w < 32; w++) $[w] = m[w];
          for (w = 0; w < 32; w++) for (k = 0; k < 32; k++) $[w + k] += y[w] * d[k];
          return Xt(o.subarray(32), $), Ee;
        }
        function an(o, c) {
          var f = t(), s = t(), d = t(), y = t(), m = t(), w = t(), k = t();
          return q(o[2], l), be(o[1], c), Be(d, o[1]), z(y, d, p), fe(d, d, o[2]), me(y, o[2], y), Be(m, y), Be(w, m), z(k, w, m), z(f, k, d), z(f, f, y), it(f, f), z(f, f, d), z(f, f, y), z(f, f, y), z(o[0], f, y), Be(s, o[0]), z(s, s, y), ye(s, d) && z(o[0], o[0], F), Be(s, o[0]), z(s, s, y), ye(s, d) ? -1 : (ve(o[0]) === c[31] >> 7 && fe(o[0], u, o[0]), z(o[3], o[0], o[1]), 0);
        }
        function hr(o, c, f, s) {
          var d, y = new Uint8Array(32), m = new Uint8Array(64), w = [
            t(),
            t(),
            t(),
            t()
          ], k = [
            t(),
            t(),
            t(),
            t()
          ];
          if (f < 64 || an(k, s)) return -1;
          for (d = 0; d < f; d++) o[d] = c[d];
          for (d = 0; d < 32; d++) o[d + 32] = s[d];
          if (St(m, o, f), lr(m), Wt(w, k, m), zt(k, c.subarray(32)), Lt(w, k), Dt(y, w), f -= 64, Ge(c, 0, y, 0)) {
            for (d = 0; d < f; d++) o[d] = 0;
            return -1;
          }
          for (d = 0; d < f; d++) o[d] = c[d + 64];
          return f;
        }
        var on = 32, Vr = 24, xr = 32, Jt = 16, pr = 32, Pr = 32, gr = 32, yr = 32, fn = 32, Vn = Vr, $s = xr, Vs = Jt, Tt = 64, Vt = 32, Qt = 64, cn = 32, dn = 64;
        e.lowlevel = {
          crypto_core_hsalsa20: Oe,
          crypto_stream_xor: We,
          crypto_stream: Ze,
          crypto_stream_salsa20_xor: Fe,
          crypto_stream_salsa20: Ue,
          crypto_onetimeauth: ct,
          crypto_onetimeauth_verify: dt,
          crypto_verify_16: Me,
          crypto_verify_32: Ge,
          crypto_secretbox: _t,
          crypto_secretbox_open: lt,
          crypto_scalarmult: rt,
          crypto_scalarmult_base: Xe,
          crypto_box_beforenm: ut,
          crypto_box_afternm: jt,
          crypto_box: Lr,
          crypto_box_open: sn,
          crypto_box_keypair: ht,
          crypto_hash: St,
          crypto_sign: $r,
          crypto_sign_keypair: Kt,
          crypto_sign_open: hr,
          crypto_secretbox_KEYBYTES: on,
          crypto_secretbox_NONCEBYTES: Vr,
          crypto_secretbox_ZEROBYTES: xr,
          crypto_secretbox_BOXZEROBYTES: Jt,
          crypto_scalarmult_BYTES: pr,
          crypto_scalarmult_SCALARBYTES: Pr,
          crypto_box_PUBLICKEYBYTES: gr,
          crypto_box_SECRETKEYBYTES: yr,
          crypto_box_BEFORENMBYTES: fn,
          crypto_box_NONCEBYTES: Vn,
          crypto_box_ZEROBYTES: $s,
          crypto_box_BOXZEROBYTES: Vs,
          crypto_sign_BYTES: Tt,
          crypto_sign_PUBLICKEYBYTES: Vt,
          crypto_sign_SECRETKEYBYTES: Qt,
          crypto_sign_SEEDBYTES: cn,
          crypto_hash_BYTES: dn,
          gf: t,
          D: p,
          L: $t,
          pack25519: G,
          unpack25519: be,
          M: z,
          A: me,
          S: Be,
          Z: fe,
          pow2523: it,
          add: Lt,
          set25519: q,
          modL: Xt,
          scalarmult: Wt,
          scalarbase: zt
        };
        function Pn(o, c) {
          if (o.length !== on) throw new Error("bad key size");
          if (c.length !== Vr) throw new Error("bad nonce size");
        }
        function Ps(o, c) {
          if (o.length !== gr) throw new Error("bad public key size");
          if (c.length !== yr) throw new Error("bad secret key size");
        }
        function ot() {
          for (var o = 0; o < arguments.length; o++) if (!(arguments[o] instanceof Uint8Array)) throw new TypeError("unexpected type, use Uint8Array");
        }
        function Yn(o) {
          for (var c = 0; c < o.length; c++) o[c] = 0;
        }
        e.randomBytes = function(o) {
          var c = new Uint8Array(o);
          return n(c, o), c;
        }, e.secretbox = function(o, c, f) {
          ot(o, c, f), Pn(f, c);
          for (var s = new Uint8Array(xr + o.length), d = new Uint8Array(s.length), y = 0; y < o.length; y++) s[y + xr] = o[y];
          return _t(d, s, s.length, c, f), d.subarray(Jt);
        }, e.secretbox.open = function(o, c, f) {
          ot(o, c, f), Pn(f, c);
          for (var s = new Uint8Array(Jt + o.length), d = new Uint8Array(s.length), y = 0; y < o.length; y++) s[y + Jt] = o[y];
          return s.length < 32 || lt(d, s, s.length, c, f) !== 0 ? null : d.subarray(xr);
        }, e.secretbox.keyLength = on, e.secretbox.nonceLength = Vr, e.secretbox.overheadLength = Jt, e.scalarMult = function(o, c) {
          if (ot(o, c), o.length !== Pr) throw new Error("bad n size");
          if (c.length !== pr) throw new Error("bad p size");
          var f = new Uint8Array(pr);
          return rt(f, o, c), f;
        }, e.scalarMult.base = function(o) {
          if (ot(o), o.length !== Pr) throw new Error("bad n size");
          var c = new Uint8Array(pr);
          return Xe(c, o), c;
        }, e.scalarMult.scalarLength = Pr, e.scalarMult.groupElementLength = pr, e.box = function(o, c, f, s) {
          var d = e.box.before(f, s);
          return e.secretbox(o, c, d);
        }, e.box.before = function(o, c) {
          ot(o, c), Ps(o, c);
          var f = new Uint8Array(fn);
          return ut(f, o, c), f;
        }, e.box.after = e.secretbox, e.box.open = function(o, c, f, s) {
          var d = e.box.before(f, s);
          return e.secretbox.open(o, c, d);
        }, e.box.open.after = e.secretbox.open, e.box.keyPair = function() {
          var o = new Uint8Array(gr), c = new Uint8Array(yr);
          return ht(o, c), {
            publicKey: o,
            secretKey: c
          };
        }, e.box.keyPair.fromSecretKey = function(o) {
          if (ot(o), o.length !== yr) throw new Error("bad secret key size");
          var c = new Uint8Array(gr);
          return Xe(c, o), {
            publicKey: c,
            secretKey: new Uint8Array(o)
          };
        }, e.box.publicKeyLength = gr, e.box.secretKeyLength = yr, e.box.sharedKeyLength = fn, e.box.nonceLength = Vn, e.box.overheadLength = e.secretbox.overheadLength, e.sign = function(o, c) {
          if (ot(o, c), c.length !== Qt) throw new Error("bad secret key size");
          var f = new Uint8Array(Tt + o.length);
          return $r(f, o, o.length, c), f;
        }, e.sign.open = function(o, c) {
          if (ot(o, c), c.length !== Vt) throw new Error("bad public key size");
          var f = new Uint8Array(o.length), s = hr(f, o, o.length, c);
          if (s < 0) return null;
          for (var d = new Uint8Array(s), y = 0; y < d.length; y++) d[y] = f[y];
          return d;
        }, e.sign.detached = function(o, c) {
          for (var f = e.sign(o, c), s = new Uint8Array(Tt), d = 0; d < s.length; d++) s[d] = f[d];
          return s;
        }, e.sign.detached.verify = function(o, c, f) {
          if (ot(o, c, f), c.length !== Tt) throw new Error("bad signature size");
          if (f.length !== Vt) throw new Error("bad public key size");
          var s = new Uint8Array(Tt + o.length), d = new Uint8Array(Tt + o.length), y;
          for (y = 0; y < Tt; y++) s[y] = c[y];
          for (y = 0; y < o.length; y++) s[y + Tt] = o[y];
          return hr(d, s, s.length, f) >= 0;
        }, e.sign.keyPair = function() {
          var o = new Uint8Array(Vt), c = new Uint8Array(Qt);
          return Kt(o, c), {
            publicKey: o,
            secretKey: c
          };
        }, e.sign.keyPair.fromSecretKey = function(o) {
          if (ot(o), o.length !== Qt) throw new Error("bad secret key size");
          for (var c = new Uint8Array(Vt), f = 0; f < c.length; f++) c[f] = o[32 + f];
          return {
            publicKey: c,
            secretKey: new Uint8Array(o)
          };
        }, e.sign.keyPair.fromSeed = function(o) {
          if (ot(o), o.length !== cn) throw new Error("bad seed size");
          for (var c = new Uint8Array(Vt), f = new Uint8Array(Qt), s = 0; s < 32; s++) f[s] = o[s];
          return Kt(c, f, true), {
            publicKey: c,
            secretKey: f
          };
        }, e.sign.publicKeyLength = Vt, e.sign.secretKeyLength = Qt, e.sign.seedLength = cn, e.sign.signatureLength = Tt, e.hash = function(o) {
          ot(o);
          var c = new Uint8Array(dn);
          return St(c, o, o.length), c;
        }, e.hash.hashLength = dn, e.verify = function(o, c) {
          return ot(o, c), o.length === 0 || c.length === 0 || o.length !== c.length ? false : xe(o, 0, c, 0, o.length) === 0;
        }, e.setPRNG = function(o) {
          n = o;
        }, function() {
          var o = typeof self < "u" ? self.crypto || self.msCrypto : null;
          if (o && o.getRandomValues) {
            var c = 65536;
            e.setPRNG(function(f, s) {
              var d, y = new Uint8Array(s);
              for (d = 0; d < s; d += c) o.getRandomValues(y.subarray(d, d + Math.min(s - d, c)));
              for (d = 0; d < s; d++) f[d] = y[d];
              Yn(y);
            });
          } else typeof Qo < "u" && (o = Js, o && o.randomBytes && e.setPRNG(function(f, s) {
            var d, y = o.randomBytes(s);
            for (d = 0; d < s; d++) f[d] = y[d];
            Yn(y);
          }));
        }();
      })(r.exports ? r.exports : self.nacl = self.nacl || {});
    }(wn)), wn.exports;
  }
  var tf = ef();
  const or = qs(tf);
  function Rn(r, e) {
    const t = Jo(r), n = Xo(e);
    return Ko.getSharedSecret(t, n);
  }
  function On(r, e) {
    const t = e.slice(0, or.secretbox.nonceLength), n = e.slice(or.secretbox.nonceLength), a = or.secretbox.open(n, t, r);
    if (!a) throw "Could not decrypt data";
    return a;
  }
  function zs(r, e) {
    const t = or.randomBytes(or.secretbox.nonceLength), n = or.secretbox(e, t, r), a = new Uint8Array(t.length + n.length);
    return a.set(t, 0), a.set(n, t.length), a;
  }
  function rf(r) {
    const e = r.reduce((a, i) => a + i.byteLength, 0), t = new Uint8Array(e);
    let n = 0;
    return r.forEach((a) => {
      t.set(a, n), n += a.byteLength;
    }), t;
  }
  async function nf(r) {
    return Gs(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(r))));
  }
  class fs {
    storage;
    constructor(e) {
      this.storage = e;
    }
    loadedChunks = [];
    loadedHeads = [];
    async loadFromStorage() {
      const e = (await this.storage.loadRange([
        "data"
      ])).filter((a) => !!a.data).map(({ key: a, data: i }) => ({
        kind: a[a.length - 2] == "snapshot" ? "snapshot" : "incremental",
        hash: a[a.length - 1],
        size: i.length,
        data: i
      }));
      let t = rf(e.map((a) => a.data));
      if (t.length == 0) return;
      const n = cs(xa(), t);
      return this.loadedChunks = e.map((a) => ({
        ...a,
        data: void 0
      })), this.loadedHeads = En(n), n;
    }
    async saveToStorage(e) {
      if (!this.storage) return;
      let t = [
        ...this.loadedChunks
      ];
      const n = En(e);
      if (!(Qs(e, this.loadedHeads, n).length > 0)) return;
      const i = ea(e), u = await nf(i);
      t = t.filter((l) => l.hash !== u), await this.storage.save([
        "data",
        "snapshot",
        u
      ], i);
      for (const l of t) await this.storage.remove([
        "data",
        l.kind,
        l.hash
      ]);
      this.loadedChunks = [
        {
          hash: u,
          kind: "snapshot",
          size: i.length
        }
      ], this.loadedHeads = n;
    }
  }
  function An(r, e) {
    return {
      async load(t) {
        const n = await e.load(t);
        return n && On(r, n);
      },
      async loadRange(t) {
        return (await e.loadRange(t)).map((a) => ({
          key: a.key,
          data: a.data && On(r, a.data)
        }));
      },
      remove(t) {
        return e.remove(t);
      },
      removeRange(t) {
        return e.removeRange(t);
      },
      save(t, n) {
        return e.save(t, zs(r, n));
      }
    };
  }
  function sf(r, e, t) {
    return r.has(e) || r.set(e, t), r.get(e);
  }
  class af extends Event {
    docId;
    constructor(e) {
      super("public-storage-saved"), this.docId = e;
    }
  }
  class $n extends Es {
    #e;
    #t;
    router;
    privateKey;
    syncManagers = /* @__PURE__ */ new Map();
    #r = /* @__PURE__ */ new Map();
    get docs() {
      return this.#e(), this.#r;
    }
    storageFactory;
    publicStorageFactory;
    publicStorageDebouncePeriod = 5 * 1e3;
    constructor({ router: e, storageFactory: t, publicStorageFactory: n, publicStorageDebouncePeriod: a, privateKey: i }) {
      super(), this.router = e, this.privateKey = i, this.storageFactory = t, this.publicStorageFactory = n, a && (this.publicStorageDebouncePeriod = a), this.#t = () => {
      }, this.#e = us((u) => {
        this.#t = u;
      }), this.router.addEventListener("close", () => {
        this.syncManagers.clear();
      }), this.router.addEventListener("join", async ({ did: u, connId: l, docId: x }) => {
        const p = sf(this.syncManagers, x, []), g = Rn(this.privateKey, await Sn(u)), I = new ff((F) => {
          this.router.send(u, l, x, zs(g, F));
        }), Y = this.#r.get(x);
        Y && I.sync(Y.view), p.push({
          did: u,
          connId: l,
          manager: I
        });
      }), this.router.addEventListener("leave", ({ did: u, connId: l, docId: x }) => {
        const p = this.syncManagers.get(x);
        p && this.syncManagers.set(x, p.filter((g) => g.did !== u || g.connId !== l));
      }), this.router.addEventListener("data", async ({ data: u, did: l, connId: x, docId: p }) => {
        const g = this.syncManagers.get(p) || [], { manager: I } = g.find((xe) => xe.did == l && xe.connId == x) || {}, Y = Rn(this.privateKey, await Sn(l));
        if (!I) return;
        const F = this.#r.get(p);
        if (!F) {
          console.warn("Got message from doc we don't have locally:", p);
          return;
        }
        const de = I.receiveMessage(F.view, On(Y, u));
        F.view = de;
      }), this.router.addEventListener("error", (u) => console.error("Router error", u));
    }
    static async init(e) {
      const t = new $n(e);
      return await t.router.open, t;
    }
    open(e, t) {
      const n = new of({
        docId: e,
        initSchema: t,
        peer: this
      });
      return this.router.addInterests(e), n.addEventListener("change", () => {
        const a = this.syncManagers.get(e) || [];
        for (const { manager: i } of a) i.sync(n.view);
      }), n.addEventListener("public-storage-saved", () => {
        this.dispatchTypedEvent("public-storage-saved", new af(e));
      }), this.#r.set(e, n), this.#t(), n;
    }
  }
  class of extends Es {
    #e;
    storage;
    #t = false;
    publicStorage;
    #r;
    #s;
    #n;
    get view() {
      return this.#s(), this.#e;
    }
    set view(e) {
      this.#e = e, this.storage ? this.storage.saveToStorage(this.#e) : this.#t = true, this.#r && this.#r(), this.dispatchTypedEvent("change", new Event("change")), this.#n();
    }
    constructor({ peer: e, docId: t, initSchema: n }) {
      super(), this.#n = () => {
      }, this.#s = us((a) => {
        this.#n = a;
      }), this.#e = pa(n), e.storageFactory && e.storageFactory(t).then((a) => {
        a && (this.storage = new fs(a), this.storage.loadFromStorage().then((i) => {
          i && (this.view = Hn(this.view, i));
        }), this.#t == true && (this.#t = false, this.storage.saveToStorage(this.#e)));
      }), e.publicStorageFactory && e.publicStorageFactory(t).then((a) => {
        a && (this.publicStorage = new fs(a), this.publicStorage.loadFromStorage().then((i) => {
          i && (this.view = Hn(this.view, i));
        }), this.#r = sa(() => {
          this.publicStorage?.saveToStorage(this.view), this.dispatchTypedEvent("public-storage-saved", new Event("public-storage-saved"));
        }, e.publicStorageDebouncePeriod));
      });
    }
    change(e) {
      this.view = aa(this.view, e);
    }
    heads() {
      return En(this.view);
    }
  }
  class ff {
    send;
    syncState;
    constructor(e) {
      this.send = e, this.syncState = ta();
    }
    async sync(e) {
      let t;
      do
        [this.syncState, t] = ra(e, this.syncState), t && this.send(t);
      while (t);
    }
    receiveMessage(e, t) {
      const [n, a] = na(e, this.syncState, t);
      return this.syncState = a, n;
    }
  }
  He = Hs({
    catalog: void 0,
    dms: {},
    spaces: {},
    router: void 0,
    routerConnections: {},
    peer: void 0
  });
  globalThis.g = He;
  async function cf(r, e) {
    const t = await r.call("chat.roomy.v0.router.token", void 0, void 0, {
      headers: {
        "atproto-proxy": "did:web:v0.router.roomy.chat#roomy_router"
      }
    });
    if (!t.success) throw new Error(`Error obtaining router auth token ${t}`);
    const n = t.data.token, a = new Li(n, `wss://v0.router.roomy.chat/connect/as/${r.assertDid}`);
    return await $n.init({
      router: a,
      privateKey: e,
      async storageFactory(i) {
        return mr(new Ws("roomy", "autodoc"), i);
      },
      async publicStorageFactory(i) {
        if (i.startsWith("catalog/")) return An(e, mr(new yt(r), i));
        if (i.startsWith("dm/")) {
          const u = i.split("/").slice(1), l = u.find((g) => g !== r.assertDid);
          if (!l) {
            if (u[0] === u[1]) return An(e, mr(new yt(r), i));
            throw `Invalid DM doc ID: ${i}`;
          }
          const x = await Sn(l), p = Rn(e, x);
          return An(p, mr(new yt(r, l), i));
        } else {
          let u = [];
          try {
            u = (await (await fetch(`https://spaces.roomy.chat/xrpc/chat.roomy.v0.space.sync.peers?docId=${i}`)).json()).peers;
          } catch (l) {
            console.warn("Couldn't get peers to sync with from spaces server", l);
          }
          return mr(new yt(r, ...u), i);
        }
      }
    });
  }
  Ys(() => {
    un(() => {
      st.agent && st.keypair.value?.privateKey && !He.peer && cf(st.agent, st.keypair.value.privateKey).then((r) => {
        He.peer = r, r.addEventListener("public-storage-saved", ({ docId: e }) => {
          const t = He.peer?.docs.get(e);
          t && e.startsWith("space/") && (console.log("updating spaces"), st.agent?.call("chat.roomy.v0.space.update", void 0, {
            [e]: ia(t.view).map(oa).map((n) => ({
              hash: n.hash,
              deps: n.deps
            }))
          }, {
            headers: {
              "atproto-proxy": "did:web:spaces.roomy.chat#roomy_spaces"
            }
          }));
        });
      });
    }), un(() => {
      st.agent && He.peer && !He.catalog && (He.catalog = He.peer.open(`catalog/${st.agent.assertDid}`, va));
    }), un(() => {
      if (st.agent && st.keypair.value && He.peer) {
        for (const r of Object.keys(He.catalog?.view.dms || {})) Object.hasOwn(He.dms, r) || (async () => {
          if (!(st.agent && st.keypair.value && He.peer)) return;
          let e = [
            r,
            st.agent.assertDid
          ];
          e.sort();
          const t = `dm/${e.join("/")}`, n = He.peer.open(t, ba);
          He.dms[r] = n;
        })();
        for (const { id: r } of He.catalog?.view.spaces || []) Object.hasOwn(He.spaces, r) || (async () => {
          if (!(st.agent && st.keypair.value && He.peer)) return;
          const e = `space/${r}`, t = He.peer.open(e, _a);
          He.spaces[r] = t;
        })();
      }
    });
  });
});
export {
  yt as R,
  __tla,
  He as g
};
