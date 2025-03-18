import { D as DEV } from "./chunks/index.js";
import { a as assets, b as base, c as app_dir, p as public_env, s as safe_public_env, o as override, r as reset, d as read_implementation, e as options, g as get_hooks, f as set_private_env, h as prerendering, i as set_public_env, j as set_safe_public_env, k as set_read_implementation } from "./chunks/internal.js";
import { m as make_trackable, d as disable_search, a as decode_params, r as readable, w as writable, v as validate_layout_server_exports, b as validate_layout_exports, c as validate_page_server_exports, e as validate_page_exports, n as normalize_path, f as resolve, g as decode_pathname, h as validate_server_exports } from "./chunks/exports.js";
let Server;
let __tla = (async () => {
  const SVELTE_KIT_ASSETS = "/_svelte_kit_assets";
  const ENDPOINT_METHODS = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD"
  ];
  const PAGE_METHODS = [
    "GET",
    "POST",
    "HEAD"
  ];
  function negotiate(accept, types) {
    const parts = [];
    accept.split(",").forEach((str, i) => {
      const match = /([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(str);
      if (match) {
        const [, type, subtype, q = "1"] = match;
        parts.push({
          type,
          subtype,
          q: +q,
          i
        });
      }
    });
    parts.sort((a, b) => {
      if (a.q !== b.q) {
        return b.q - a.q;
      }
      if (a.subtype === "*" !== (b.subtype === "*")) {
        return a.subtype === "*" ? 1 : -1;
      }
      if (a.type === "*" !== (b.type === "*")) {
        return a.type === "*" ? 1 : -1;
      }
      return a.i - b.i;
    });
    let accepted;
    let min_priority = Infinity;
    for (const mimetype of types) {
      const [type, subtype] = mimetype.split("/");
      const priority = parts.findIndex((part) => (part.type === type || part.type === "*") && (part.subtype === subtype || part.subtype === "*"));
      if (priority !== -1 && priority < min_priority) {
        accepted = mimetype;
        min_priority = priority;
      }
    }
    return accepted;
  }
  function is_content_type(request, ...types) {
    const type = request.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    return types.includes(type.toLowerCase());
  }
  function is_form_content_type(request) {
    return is_content_type(request, "application/x-www-form-urlencoded", "multipart/form-data", "text/plain");
  }
  let request_event = null;
  let als;
  try {
    const hooks = await import("node:async_hooks").then(async (m) => {
      await m.__tla;
      return m;
    });
    als = new hooks.AsyncLocalStorage();
  } catch {
  }
  function with_event(event, fn) {
    try {
      request_event = event;
      return als ? als.run(event, fn) : fn();
    } finally {
      request_event = null;
    }
  }
  class HttpError {
    constructor(status, body2) {
      this.status = status;
      if (typeof body2 === "string") {
        this.body = {
          message: body2
        };
      } else if (body2) {
        this.body = body2;
      } else {
        this.body = {
          message: `Error: ${status}`
        };
      }
    }
    toString() {
      return JSON.stringify(this.body);
    }
  }
  class Redirect {
    constructor(status, location) {
      this.status = status;
      this.location = location;
    }
  }
  class SvelteKitError extends Error {
    constructor(status, text2, message) {
      super(message);
      this.status = status;
      this.text = text2;
    }
  }
  class ActionFailure {
    constructor(status, data) {
      this.status = status;
      this.data = data;
    }
  }
  const DATA_SUFFIX = "/__data.json";
  const HTML_DATA_SUFFIX = ".html__data.json";
  function has_data_suffix(pathname) {
    return pathname.endsWith(DATA_SUFFIX) || pathname.endsWith(HTML_DATA_SUFFIX);
  }
  function add_data_suffix(pathname) {
    if (pathname.endsWith(".html")) return pathname.replace(/\.html$/, HTML_DATA_SUFFIX);
    return pathname.replace(/\/$/, "") + DATA_SUFFIX;
  }
  function strip_data_suffix(pathname) {
    if (pathname.endsWith(HTML_DATA_SUFFIX)) {
      return pathname.slice(0, -HTML_DATA_SUFFIX.length) + ".html";
    }
    return pathname.slice(0, -DATA_SUFFIX.length);
  }
  const ROUTE_SUFFIX = "/__route.js";
  function has_resolution_suffix(pathname) {
    return pathname.endsWith(ROUTE_SUFFIX);
  }
  function add_resolution_suffix(pathname) {
    return pathname.replace(/\/$/, "") + ROUTE_SUFFIX;
  }
  function strip_resolution_suffix(pathname) {
    return pathname.slice(0, -ROUTE_SUFFIX.length);
  }
  function json(data, init2) {
    const body2 = JSON.stringify(data);
    const headers2 = new Headers(init2?.headers);
    if (!headers2.has("content-length")) {
      headers2.set("content-length", encoder$3.encode(body2).byteLength.toString());
    }
    if (!headers2.has("content-type")) {
      headers2.set("content-type", "application/json");
    }
    return new Response(body2, {
      ...init2,
      headers: headers2
    });
  }
  const encoder$3 = new TextEncoder();
  function text(body2, init2) {
    const headers2 = new Headers(init2?.headers);
    if (!headers2.has("content-length")) {
      const encoded = encoder$3.encode(body2);
      headers2.set("content-length", encoded.byteLength.toString());
      return new Response(encoded, {
        ...init2,
        headers: headers2
      });
    }
    return new Response(body2, {
      ...init2,
      headers: headers2
    });
  }
  function coalesce_to_error(err) {
    return err instanceof Error || err && err.name && err.message ? err : new Error(JSON.stringify(err));
  }
  function normalize_error(error) {
    return error;
  }
  function get_status(error) {
    return error instanceof HttpError || error instanceof SvelteKitError ? error.status : 500;
  }
  function get_message(error) {
    return error instanceof SvelteKitError ? error.text : "Internal Error";
  }
  const escape_html_attr_dict = {
    "&": "&amp;",
    '"': "&quot;"
  };
  const escape_html_dict = {
    "&": "&amp;",
    "<": "&lt;"
  };
  const surrogates = "[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]";
  const escape_html_attr_regex = new RegExp(`[${Object.keys(escape_html_attr_dict).join("")}]|` + surrogates, "g");
  const escape_html_regex = new RegExp(`[${Object.keys(escape_html_dict).join("")}]|` + surrogates, "g");
  function escape_html(str, is_attr) {
    const dict = is_attr ? escape_html_attr_dict : escape_html_dict;
    const escaped_str = str.replace(is_attr ? escape_html_attr_regex : escape_html_regex, (match) => {
      if (match.length === 2) {
        return match;
      }
      return dict[match] ?? `&#${match.charCodeAt(0)};`;
    });
    return escaped_str;
  }
  function method_not_allowed(mod, method) {
    return text(`${method} method not allowed`, {
      status: 405,
      headers: {
        allow: allowed_methods(mod).join(", ")
      }
    });
  }
  function allowed_methods(mod) {
    const allowed = ENDPOINT_METHODS.filter((method) => method in mod);
    if ("GET" in mod || "HEAD" in mod) allowed.push("HEAD");
    return allowed;
  }
  function static_error_page(options2, status, message) {
    let page = options2.templates.error({
      status,
      message: escape_html(message)
    });
    return text(page, {
      headers: {
        "content-type": "text/html; charset=utf-8"
      },
      status
    });
  }
  async function handle_fatal_error(event, options2, error) {
    error = error instanceof HttpError ? error : coalesce_to_error(error);
    const status = get_status(error);
    const body2 = await handle_error_and_jsonify(event, options2, error);
    const type = negotiate(event.request.headers.get("accept") || "text/html", [
      "application/json",
      "text/html"
    ]);
    if (event.isDataRequest || type === "application/json") {
      return json(body2, {
        status
      });
    }
    return static_error_page(options2, status, body2.message);
  }
  async function handle_error_and_jsonify(event, options2, error) {
    if (error instanceof HttpError) {
      return error.body;
    }
    const status = get_status(error);
    const message = get_message(error);
    return await options2.hooks.handleError({
      error,
      event,
      status,
      message
    }) ?? {
      message
    };
  }
  function redirect_response(status, location) {
    const response = new Response(void 0, {
      status,
      headers: {
        location
      }
    });
    return response;
  }
  function clarify_devalue_error(event, error) {
    if (error.path) {
      return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error.message} (data${error.path})`;
    }
    if (error.path === "") {
      return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
    }
    return error.message;
  }
  function stringify_uses(node) {
    const uses = [];
    if (node.uses && node.uses.dependencies.size > 0) {
      uses.push(`"dependencies":${JSON.stringify(Array.from(node.uses.dependencies))}`);
    }
    if (node.uses && node.uses.search_params.size > 0) {
      uses.push(`"search_params":${JSON.stringify(Array.from(node.uses.search_params))}`);
    }
    if (node.uses && node.uses.params.size > 0) {
      uses.push(`"params":${JSON.stringify(Array.from(node.uses.params))}`);
    }
    if (node.uses?.parent) uses.push('"parent":1');
    if (node.uses?.route) uses.push('"route":1');
    if (node.uses?.url) uses.push('"url":1');
    return `"uses":{${uses.join(",")}}`;
  }
  function has_prerendered_path(manifest, pathname) {
    return manifest._.prerendered_routes.has(pathname) || pathname.at(-1) === "/" && manifest._.prerendered_routes.has(pathname.slice(0, -1));
  }
  async function render_endpoint(event, mod, state) {
    const method = event.request.method;
    let handler = mod[method] || mod.fallback;
    if (method === "HEAD" && mod.GET && !mod.HEAD) {
      handler = mod.GET;
    }
    if (!handler) {
      return method_not_allowed(mod, method);
    }
    const prerender = mod.prerender ?? state.prerender_default;
    if (prerender && (mod.POST || mod.PATCH || mod.PUT || mod.DELETE)) {
      throw new Error("Cannot prerender endpoints that have mutative methods");
    }
    if (state.prerendering && !prerender) {
      if (state.depth > 0) {
        throw new Error(`${event.route.id} is not prerenderable`);
      } else {
        return new Response(void 0, {
          status: 204
        });
      }
    }
    try {
      let response = await with_event(event, () => handler(event));
      if (!(response instanceof Response)) {
        throw new Error(`Invalid response from route ${event.url.pathname}: handler should return a Response object`);
      }
      if (state.prerendering) {
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers)
        });
        response.headers.set("x-sveltekit-prerender", String(prerender));
      }
      return response;
    } catch (e) {
      if (e instanceof Redirect) {
        return new Response(void 0, {
          status: e.status,
          headers: {
            location: e.location
          }
        });
      }
      throw e;
    }
  }
  function is_endpoint_request(event) {
    const { method, headers: headers2 } = event.request;
    if (ENDPOINT_METHODS.includes(method) && !PAGE_METHODS.includes(method)) {
      return true;
    }
    if (method === "POST" && headers2.get("x-sveltekit-action") === "true") return false;
    const accept = event.request.headers.get("accept") ?? "*/*";
    return negotiate(accept, [
      "*",
      "text/html"
    ]) !== "text/html";
  }
  function compact(arr) {
    return arr.filter((val) => val != null);
  }
  const escaped = {
    "<": "\\u003C",
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "	": "\\t",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029"
  };
  class DevalueError extends Error {
    constructor(message, keys) {
      super(message);
      this.name = "DevalueError";
      this.path = keys.join("");
    }
  }
  function is_primitive(thing) {
    return Object(thing) !== thing;
  }
  const object_proto_names = Object.getOwnPropertyNames(Object.prototype).sort().join("\0");
  function is_plain_object(thing) {
    const proto = Object.getPrototypeOf(thing);
    return proto === Object.prototype || proto === null || Object.getOwnPropertyNames(proto).sort().join("\0") === object_proto_names;
  }
  function get_type(thing) {
    return Object.prototype.toString.call(thing).slice(8, -1);
  }
  function get_escaped_char(char) {
    switch (char) {
      case '"':
        return '\\"';
      case "<":
        return "\\u003C";
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "	":
        return "\\t";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char < " " ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : "";
    }
  }
  function stringify_string(str) {
    let result = "";
    let last_pos = 0;
    const len = str.length;
    for (let i = 0; i < len; i += 1) {
      const char = str[i];
      const replacement = get_escaped_char(char);
      if (replacement) {
        result += str.slice(last_pos, i) + replacement;
        last_pos = i + 1;
      }
    }
    return `"${last_pos === 0 ? str : result + str.slice(last_pos)}"`;
  }
  function enumerable_symbols(object) {
    return Object.getOwnPropertySymbols(object).filter((symbol) => Object.getOwnPropertyDescriptor(object, symbol).enumerable);
  }
  const is_identifier = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;
  function stringify_key(key2) {
    return is_identifier.test(key2) ? "." + key2 : "[" + JSON.stringify(key2) + "]";
  }
  const chars$1 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
  const unsafe_chars = /[<\b\f\n\r\t\0\u2028\u2029]/g;
  const reserved = /^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;
  function uneval(value, replacer) {
    const counts = /* @__PURE__ */ new Map();
    const keys = [];
    const custom = /* @__PURE__ */ new Map();
    function walk(thing) {
      if (typeof thing === "function") {
        throw new DevalueError(`Cannot stringify a function`, keys);
      }
      if (!is_primitive(thing)) {
        if (counts.has(thing)) {
          counts.set(thing, counts.get(thing) + 1);
          return;
        }
        counts.set(thing, 1);
        if (replacer) {
          const str2 = replacer(thing);
          if (typeof str2 === "string") {
            custom.set(thing, str2);
            return;
          }
        }
        const type = get_type(thing);
        switch (type) {
          case "Number":
          case "BigInt":
          case "String":
          case "Boolean":
          case "Date":
          case "RegExp":
            return;
          case "Array":
            thing.forEach((value2, i) => {
              keys.push(`[${i}]`);
              walk(value2);
              keys.pop();
            });
            break;
          case "Set":
            Array.from(thing).forEach(walk);
            break;
          case "Map":
            for (const [key2, value2] of thing) {
              keys.push(`.get(${is_primitive(key2) ? stringify_primitive$1(key2) : "..."})`);
              walk(value2);
              keys.pop();
            }
            break;
          case "Int8Array":
          case "Uint8Array":
          case "Uint8ClampedArray":
          case "Int16Array":
          case "Uint16Array":
          case "Int32Array":
          case "Uint32Array":
          case "Float32Array":
          case "Float64Array":
          case "BigInt64Array":
          case "BigUint64Array":
            return;
          case "ArrayBuffer":
            return;
          default:
            if (!is_plain_object(thing)) {
              throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys);
            }
            if (enumerable_symbols(thing).length > 0) {
              throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys);
            }
            for (const key2 in thing) {
              keys.push(stringify_key(key2));
              walk(thing[key2]);
              keys.pop();
            }
        }
      }
    }
    walk(value);
    const names = /* @__PURE__ */ new Map();
    Array.from(counts).filter((entry) => entry[1] > 1).sort((a, b) => b[1] - a[1]).forEach((entry, i) => {
      names.set(entry[0], get_name(i));
    });
    function stringify2(thing) {
      if (names.has(thing)) {
        return names.get(thing);
      }
      if (is_primitive(thing)) {
        return stringify_primitive$1(thing);
      }
      if (custom.has(thing)) {
        return custom.get(thing);
      }
      const type = get_type(thing);
      switch (type) {
        case "Number":
        case "String":
        case "Boolean":
          return `Object(${stringify2(thing.valueOf())})`;
        case "RegExp":
          return `new RegExp(${stringify_string(thing.source)}, "${thing.flags}")`;
        case "Date":
          return `new Date(${thing.getTime()})`;
        case "Array":
          const members = thing.map((v, i) => i in thing ? stringify2(v) : "");
          const tail = thing.length === 0 || thing.length - 1 in thing ? "" : ",";
          return `[${members.join(",")}${tail}]`;
        case "Set":
        case "Map":
          return `new ${type}([${Array.from(thing).map(stringify2).join(",")}])`;
        case "Int8Array":
        case "Uint8Array":
        case "Uint8ClampedArray":
        case "Int16Array":
        case "Uint16Array":
        case "Int32Array":
        case "Uint32Array":
        case "Float32Array":
        case "Float64Array":
        case "BigInt64Array":
        case "BigUint64Array": {
          const typedArray = thing;
          return `new ${type}([${typedArray.toString()}])`;
        }
        case "ArrayBuffer": {
          const ui8 = new Uint8Array(thing);
          return `new Uint8Array([${ui8.toString()}]).buffer`;
        }
        default:
          const obj = `{${Object.keys(thing).map((key2) => `${safe_key(key2)}:${stringify2(thing[key2])}`).join(",")}}`;
          const proto = Object.getPrototypeOf(thing);
          if (proto === null) {
            return Object.keys(thing).length > 0 ? `Object.assign(Object.create(null),${obj})` : `Object.create(null)`;
          }
          return obj;
      }
    }
    const str = stringify2(value);
    if (names.size) {
      const params = [];
      const statements = [];
      const values = [];
      names.forEach((name, thing) => {
        params.push(name);
        if (custom.has(thing)) {
          values.push(custom.get(thing));
          return;
        }
        if (is_primitive(thing)) {
          values.push(stringify_primitive$1(thing));
          return;
        }
        const type = get_type(thing);
        switch (type) {
          case "Number":
          case "String":
          case "Boolean":
            values.push(`Object(${stringify2(thing.valueOf())})`);
            break;
          case "RegExp":
            values.push(thing.toString());
            break;
          case "Date":
            values.push(`new Date(${thing.getTime()})`);
            break;
          case "Array":
            values.push(`Array(${thing.length})`);
            thing.forEach((v, i) => {
              statements.push(`${name}[${i}]=${stringify2(v)}`);
            });
            break;
          case "Set":
            values.push(`new Set`);
            statements.push(`${name}.${Array.from(thing).map((v) => `add(${stringify2(v)})`).join(".")}`);
            break;
          case "Map":
            values.push(`new Map`);
            statements.push(`${name}.${Array.from(thing).map(([k, v]) => `set(${stringify2(k)}, ${stringify2(v)})`).join(".")}`);
            break;
          default:
            values.push(Object.getPrototypeOf(thing) === null ? "Object.create(null)" : "{}");
            Object.keys(thing).forEach((key2) => {
              statements.push(`${name}${safe_prop(key2)}=${stringify2(thing[key2])}`);
            });
        }
      });
      statements.push(`return ${str}`);
      return `(function(${params.join(",")}){${statements.join(";")}}(${values.join(",")}))`;
    } else {
      return str;
    }
  }
  function get_name(num) {
    let name = "";
    do {
      name = chars$1[num % chars$1.length] + name;
      num = ~~(num / chars$1.length) - 1;
    } while (num >= 0);
    return reserved.test(name) ? `${name}0` : name;
  }
  function escape_unsafe_char(c) {
    return escaped[c] || c;
  }
  function escape_unsafe_chars(str) {
    return str.replace(unsafe_chars, escape_unsafe_char);
  }
  function safe_key(key2) {
    return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key2) ? key2 : escape_unsafe_chars(JSON.stringify(key2));
  }
  function safe_prop(key2) {
    return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key2) ? `.${key2}` : `[${escape_unsafe_chars(JSON.stringify(key2))}]`;
  }
  function stringify_primitive$1(thing) {
    if (typeof thing === "string") return stringify_string(thing);
    if (thing === void 0) return "void 0";
    if (thing === 0 && 1 / thing < 0) return "-0";
    const str = String(thing);
    if (typeof thing === "number") return str.replace(/^(-)?0\./, "$1.");
    if (typeof thing === "bigint") return thing + "n";
    return str;
  }
  function encode64(arraybuffer) {
    const dv = new DataView(arraybuffer);
    let binaryString = "";
    for (let i = 0; i < arraybuffer.byteLength; i++) {
      binaryString += String.fromCharCode(dv.getUint8(i));
    }
    return binaryToAscii(binaryString);
  }
  const KEY_STRING = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function binaryToAscii(str) {
    let out = "";
    for (let i = 0; i < str.length; i += 3) {
      const groupsOfSix = [
        void 0,
        void 0,
        void 0,
        void 0
      ];
      groupsOfSix[0] = str.charCodeAt(i) >> 2;
      groupsOfSix[1] = (str.charCodeAt(i) & 3) << 4;
      if (str.length > i + 1) {
        groupsOfSix[1] |= str.charCodeAt(i + 1) >> 4;
        groupsOfSix[2] = (str.charCodeAt(i + 1) & 15) << 2;
      }
      if (str.length > i + 2) {
        groupsOfSix[2] |= str.charCodeAt(i + 2) >> 6;
        groupsOfSix[3] = str.charCodeAt(i + 2) & 63;
      }
      for (let j = 0; j < groupsOfSix.length; j++) {
        if (typeof groupsOfSix[j] === "undefined") {
          out += "=";
        } else {
          out += KEY_STRING[groupsOfSix[j]];
        }
      }
    }
    return out;
  }
  const UNDEFINED = -1;
  const HOLE = -2;
  const NAN = -3;
  const POSITIVE_INFINITY = -4;
  const NEGATIVE_INFINITY = -5;
  const NEGATIVE_ZERO = -6;
  function stringify(value, reducers) {
    const stringified = [];
    const indexes = /* @__PURE__ */ new Map();
    const custom = [];
    if (reducers) {
      for (const key2 of Object.getOwnPropertyNames(reducers)) {
        custom.push({
          key: key2,
          fn: reducers[key2]
        });
      }
    }
    const keys = [];
    let p = 0;
    function flatten(thing) {
      if (typeof thing === "function") {
        throw new DevalueError(`Cannot stringify a function`, keys);
      }
      if (indexes.has(thing)) return indexes.get(thing);
      if (thing === void 0) return UNDEFINED;
      if (Number.isNaN(thing)) return NAN;
      if (thing === Infinity) return POSITIVE_INFINITY;
      if (thing === -Infinity) return NEGATIVE_INFINITY;
      if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;
      const index2 = p++;
      indexes.set(thing, index2);
      for (const { key: key2, fn } of custom) {
        const value2 = fn(thing);
        if (value2) {
          stringified[index2] = `["${key2}",${flatten(value2)}]`;
          return index2;
        }
      }
      let str = "";
      if (is_primitive(thing)) {
        str = stringify_primitive(thing);
      } else {
        const type = get_type(thing);
        switch (type) {
          case "Number":
          case "String":
          case "Boolean":
            str = `["Object",${stringify_primitive(thing)}]`;
            break;
          case "BigInt":
            str = `["BigInt",${thing}]`;
            break;
          case "Date":
            const valid = !isNaN(thing.getDate());
            str = `["Date","${valid ? thing.toISOString() : ""}"]`;
            break;
          case "RegExp":
            const { source, flags } = thing;
            str = flags ? `["RegExp",${stringify_string(source)},"${flags}"]` : `["RegExp",${stringify_string(source)}]`;
            break;
          case "Array":
            str = "[";
            for (let i = 0; i < thing.length; i += 1) {
              if (i > 0) str += ",";
              if (i in thing) {
                keys.push(`[${i}]`);
                str += flatten(thing[i]);
                keys.pop();
              } else {
                str += HOLE;
              }
            }
            str += "]";
            break;
          case "Set":
            str = '["Set"';
            for (const value2 of thing) {
              str += `,${flatten(value2)}`;
            }
            str += "]";
            break;
          case "Map":
            str = '["Map"';
            for (const [key2, value2] of thing) {
              keys.push(`.get(${is_primitive(key2) ? stringify_primitive(key2) : "..."})`);
              str += `,${flatten(key2)},${flatten(value2)}`;
              keys.pop();
            }
            str += "]";
            break;
          case "Int8Array":
          case "Uint8Array":
          case "Uint8ClampedArray":
          case "Int16Array":
          case "Uint16Array":
          case "Int32Array":
          case "Uint32Array":
          case "Float32Array":
          case "Float64Array":
          case "BigInt64Array":
          case "BigUint64Array": {
            const typedArray = thing;
            const base642 = encode64(typedArray.buffer);
            str = '["' + type + '","' + base642 + '"]';
            break;
          }
          case "ArrayBuffer": {
            const arraybuffer = thing;
            const base642 = encode64(arraybuffer);
            str = `["ArrayBuffer","${base642}"]`;
            break;
          }
          default:
            if (!is_plain_object(thing)) {
              throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys);
            }
            if (enumerable_symbols(thing).length > 0) {
              throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys);
            }
            if (Object.getPrototypeOf(thing) === null) {
              str = '["null"';
              for (const key2 in thing) {
                keys.push(stringify_key(key2));
                str += `,${stringify_string(key2)},${flatten(thing[key2])}`;
                keys.pop();
              }
              str += "]";
            } else {
              str = "{";
              let started = false;
              for (const key2 in thing) {
                if (started) str += ",";
                started = true;
                keys.push(stringify_key(key2));
                str += `${stringify_string(key2)}:${flatten(thing[key2])}`;
                keys.pop();
              }
              str += "}";
            }
        }
      }
      stringified[index2] = str;
      return index2;
    }
    const index = flatten(value);
    if (index < 0) return `${index}`;
    return `[${stringified.join(",")}]`;
  }
  function stringify_primitive(thing) {
    const type = typeof thing;
    if (type === "string") return stringify_string(thing);
    if (thing instanceof String) return stringify_string(thing.toString());
    if (thing === void 0) return UNDEFINED.toString();
    if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
    if (type === "bigint") return `["BigInt","${thing}"]`;
    return String(thing);
  }
  function is_action_json_request(event) {
    const accept = negotiate(event.request.headers.get("accept") ?? "*/*", [
      "application/json",
      "text/html"
    ]);
    return accept === "application/json" && event.request.method === "POST";
  }
  async function handle_action_json_request(event, options2, server) {
    const actions = server?.actions;
    if (!actions) {
      const no_actions_error = new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for ${"this page"}`);
      return action_json({
        type: "error",
        error: await handle_error_and_jsonify(event, options2, no_actions_error)
      }, {
        status: no_actions_error.status,
        headers: {
          allow: "GET"
        }
      });
    }
    check_named_default_separate(actions);
    try {
      const data = await call_action(event, actions);
      if (false) ;
      if (data instanceof ActionFailure) {
        return action_json({
          type: "failure",
          status: data.status,
          data: stringify_action_response(data.data, event.route.id, options2.hooks.transport)
        });
      } else {
        return action_json({
          type: "success",
          status: data ? 200 : 204,
          data: stringify_action_response(data, event.route.id, options2.hooks.transport)
        });
      }
    } catch (e) {
      const err = normalize_error(e);
      if (err instanceof Redirect) {
        return action_json_redirect(err);
      }
      return action_json({
        type: "error",
        error: await handle_error_and_jsonify(event, options2, check_incorrect_fail_use(err))
      }, {
        status: get_status(err)
      });
    }
  }
  function check_incorrect_fail_use(error) {
    return error instanceof ActionFailure ? new Error('Cannot "throw fail()". Use "return fail()"') : error;
  }
  function action_json_redirect(redirect) {
    return action_json({
      type: "redirect",
      status: redirect.status,
      location: redirect.location
    });
  }
  function action_json(data, init2) {
    return json(data, init2);
  }
  function is_action_request(event) {
    return event.request.method === "POST";
  }
  async function handle_action_request(event, server) {
    const actions = server?.actions;
    if (!actions) {
      event.setHeaders({
        allow: "GET"
      });
      return {
        type: "error",
        error: new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for ${"this page"}`)
      };
    }
    check_named_default_separate(actions);
    try {
      const data = await call_action(event, actions);
      if (false) ;
      if (data instanceof ActionFailure) {
        return {
          type: "failure",
          status: data.status,
          data: data.data
        };
      } else {
        return {
          type: "success",
          status: 200,
          data
        };
      }
    } catch (e) {
      const err = normalize_error(e);
      if (err instanceof Redirect) {
        return {
          type: "redirect",
          status: err.status,
          location: err.location
        };
      }
      return {
        type: "error",
        error: check_incorrect_fail_use(err)
      };
    }
  }
  function check_named_default_separate(actions) {
    if (actions.default && Object.keys(actions).length > 1) {
      throw new Error("When using named actions, the default action cannot be used. See the docs for more info: https://svelte.dev/docs/kit/form-actions#named-actions");
    }
  }
  async function call_action(event, actions) {
    const url = new URL(event.request.url);
    let name = "default";
    for (const param of url.searchParams) {
      if (param[0].startsWith("/")) {
        name = param[0].slice(1);
        if (name === "default") {
          throw new Error('Cannot use reserved action name "default"');
        }
        break;
      }
    }
    const action = actions[name];
    if (!action) {
      throw new SvelteKitError(404, "Not Found", `No action with name '${name}' found`);
    }
    if (!is_form_content_type(event.request)) {
      throw new SvelteKitError(415, "Unsupported Media Type", `Form actions expect form-encoded data \u2014 received ${event.request.headers.get("content-type")}`);
    }
    return with_event(event, () => action(event));
  }
  function validate_action_return(data) {
    if (data instanceof Redirect) {
      throw new Error("Cannot `return redirect(...)` \u2014 use `redirect(...)` instead");
    }
    if (data instanceof HttpError) {
      throw new Error("Cannot `return error(...)` \u2014 use `error(...)` or `return fail(...)` instead");
    }
  }
  function uneval_action_response(data, route_id, transport) {
    const replacer = (thing) => {
      for (const key2 in transport) {
        const encoded = transport[key2].encode(thing);
        if (encoded) {
          return `app.decode('${key2}', ${uneval(encoded, replacer)})`;
        }
      }
    };
    return try_serialize(data, (value) => uneval(value, replacer), route_id);
  }
  function stringify_action_response(data, route_id, transport) {
    const encoders = Object.fromEntries(Object.entries(transport).map(([key2, value]) => [
      key2,
      value.encode
    ]));
    return try_serialize(data, (value) => stringify(value, encoders), route_id);
  }
  function try_serialize(data, fn, route_id) {
    try {
      return fn(data);
    } catch (e) {
      const error = e;
      if (data instanceof Response) {
        throw new Error(`Data returned from action inside ${route_id} is not serializable. Form actions need to return plain objects or fail(). E.g. return { success: true } or return fail(400, { message: "invalid" });`);
      }
      if ("path" in error) {
        let message = `Data returned from action inside ${route_id} is not serializable: ${error.message}`;
        if (error.path !== "") message += ` (data.${error.path})`;
        throw new Error(message);
      }
      throw error;
    }
  }
  function validate_depends(route_id, dep) {
    const match = /^(moz-icon|view-source|jar):/.exec(dep);
    if (match) {
      console.warn(`${route_id}: Calling \`depends('${dep}')\` will throw an error in Firefox because \`${match[1]}\` is a special URI scheme`);
    }
  }
  const INVALIDATED_PARAM = "x-sveltekit-invalidated";
  const TRAILING_SLASH_PARAM = "x-sveltekit-trailing-slash";
  function b64_encode(buffer) {
    if (globalThis.Buffer) {
      return Buffer.from(buffer).toString("base64");
    }
    const little_endian = new Uint8Array(new Uint16Array([
      1
    ]).buffer)[0] > 0;
    return btoa(new TextDecoder(little_endian ? "utf-16le" : "utf-16be").decode(new Uint16Array(new Uint8Array(buffer))));
  }
  function get_relative_path(from, to) {
    const from_parts = from.split(/[/\\]/);
    const to_parts = to.split(/[/\\]/);
    from_parts.pop();
    while (from_parts[0] === to_parts[0]) {
      from_parts.shift();
      to_parts.shift();
    }
    let i = from_parts.length;
    while (i--) from_parts[i] = "..";
    return from_parts.concat(to_parts).join("/");
  }
  async function load_server_data({ event, state, node, parent }) {
    if (!node?.server) return null;
    let is_tracking = true;
    const uses = {
      dependencies: /* @__PURE__ */ new Set(),
      params: /* @__PURE__ */ new Set(),
      parent: false,
      route: false,
      url: false,
      search_params: /* @__PURE__ */ new Set()
    };
    const load = node.server.load;
    const slash = node.server.trailingSlash;
    if (!load) {
      return {
        type: "data",
        data: null,
        uses,
        slash
      };
    }
    const url = make_trackable(event.url, () => {
      if (is_tracking) {
        uses.url = true;
      }
    }, (param) => {
      if (is_tracking) {
        uses.search_params.add(param);
      }
    });
    if (state.prerendering) {
      disable_search(url);
    }
    let done = false;
    const result = await with_event(event, () => load.call(null, {
      ...event,
      fetch: (info, init2) => {
        const url2 = new URL(info instanceof Request ? info.url : info, event.url);
        if (DEV && done && !uses.dependencies.has(url2.href)) ;
        return event.fetch(info, init2);
      },
      depends: (...deps) => {
        for (const dep of deps) {
          const { href } = new URL(dep, event.url);
          if (DEV) ;
          uses.dependencies.add(href);
        }
      },
      params: new Proxy(event.params, {
        get: (target, key2) => {
          if (DEV && done && typeof key2 === "string" && !uses.params.has(key2)) ;
          if (is_tracking) {
            uses.params.add(key2);
          }
          return target[key2];
        }
      }),
      parent: async () => {
        if (DEV && done && !uses.parent) ;
        if (is_tracking) {
          uses.parent = true;
        }
        return parent();
      },
      route: new Proxy(event.route, {
        get: (target, key2) => {
          if (DEV && done && typeof key2 === "string" && !uses.route) ;
          if (is_tracking) {
            uses.route = true;
          }
          return target[key2];
        }
      }),
      url,
      untrack(fn) {
        is_tracking = false;
        try {
          return fn();
        } finally {
          is_tracking = true;
        }
      }
    }));
    done = true;
    return {
      type: "data",
      data: result ?? null,
      uses,
      slash
    };
  }
  async function load_data({ event, fetched, node, parent, server_data_promise, state, resolve_opts, csr }) {
    const server_data_node = await server_data_promise;
    if (!node?.universal?.load) {
      return server_data_node?.data ?? null;
    }
    const result = await node.universal.load.call(null, {
      url: event.url,
      params: event.params,
      data: server_data_node?.data ?? null,
      route: event.route,
      fetch: create_universal_fetch(event, state, fetched, csr, resolve_opts),
      setHeaders: event.setHeaders,
      depends: () => {
      },
      parent,
      untrack: (fn) => fn()
    });
    return result ?? null;
  }
  function create_universal_fetch(event, state, fetched, csr, resolve_opts) {
    const universal_fetch = async (input, init2) => {
      const cloned_body = input instanceof Request && input.body ? input.clone().body : null;
      const cloned_headers = input instanceof Request && [
        ...input.headers
      ].length ? new Headers(input.headers) : init2?.headers;
      let response = await event.fetch(input, init2);
      const url = new URL(input instanceof Request ? input.url : input, event.url);
      const same_origin = url.origin === event.url.origin;
      let dependency;
      if (same_origin) {
        if (state.prerendering) {
          dependency = {
            response,
            body: null
          };
          state.prerendering.dependencies.set(url.pathname, dependency);
        }
      } else if (url.protocol === "https:" || url.protocol === "http:") {
        const mode = input instanceof Request ? input.mode : init2?.mode ?? "cors";
        if (mode === "no-cors") {
          response = new Response("", {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        } else {
          const acao = response.headers.get("access-control-allow-origin");
          if (!acao || acao !== event.url.origin && acao !== "*") {
            throw new Error(`CORS error: ${acao ? "Incorrect" : "No"} 'Access-Control-Allow-Origin' header is present on the requested resource`);
          }
        }
      }
      const proxy = new Proxy(response, {
        get(response2, key2, _receiver) {
          async function push_fetched(body2, is_b64) {
            const status_number = Number(response2.status);
            if (isNaN(status_number)) {
              throw new Error(`response.status is not a number. value: "${response2.status}" type: ${typeof response2.status}`);
            }
            fetched.push({
              url: same_origin ? url.href.slice(event.url.origin.length) : url.href,
              method: event.request.method,
              request_body: input instanceof Request && cloned_body ? await stream_to_string(cloned_body) : init2?.body,
              request_headers: cloned_headers,
              response_body: body2,
              response: response2,
              is_b64
            });
          }
          if (key2 === "arrayBuffer") {
            return async () => {
              const buffer = await response2.arrayBuffer();
              if (dependency) {
                dependency.body = new Uint8Array(buffer);
              }
              if (buffer instanceof ArrayBuffer) {
                await push_fetched(b64_encode(buffer), true);
              }
              return buffer;
            };
          }
          async function text2() {
            const body2 = await response2.text();
            if (!body2 || typeof body2 === "string") {
              await push_fetched(body2, false);
            }
            if (dependency) {
              dependency.body = body2;
            }
            return body2;
          }
          if (key2 === "text") {
            return text2;
          }
          if (key2 === "json") {
            return async () => {
              return JSON.parse(await text2());
            };
          }
          return Reflect.get(response2, key2, response2);
        }
      });
      if (csr) {
        const get = response.headers.get;
        response.headers.get = (key2) => {
          const lower = key2.toLowerCase();
          const value = get.call(response.headers, lower);
          if (value && !lower.startsWith("x-sveltekit-")) {
            const included = resolve_opts.filterSerializedResponseHeaders(lower, value);
            if (!included) {
              throw new Error(`Failed to get response header "${lower}" \u2014 it must be included by the \`filterSerializedResponseHeaders\` option: https://svelte.dev/docs/kit/hooks#Server-hooks-handle (at ${event.route.id})`);
            }
          }
          return value;
        };
      }
      return proxy;
    };
    return (input, init2) => {
      const response = universal_fetch(input, init2);
      response.catch(() => {
      });
      return response;
    };
  }
  async function stream_to_string(stream) {
    let result = "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      result += decoder.decode(value);
    }
    return result;
  }
  function hash(...values) {
    let hash2 = 5381;
    for (const value of values) {
      if (typeof value === "string") {
        let i = value.length;
        while (i) hash2 = hash2 * 33 ^ value.charCodeAt(--i);
      } else if (ArrayBuffer.isView(value)) {
        const buffer = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let i = buffer.length;
        while (i) hash2 = hash2 * 33 ^ buffer[--i];
      } else {
        throw new TypeError("value must be a string or TypedArray");
      }
    }
    return (hash2 >>> 0).toString(36);
  }
  const replacements = {
    "<": "\\u003C",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029"
  };
  const pattern = new RegExp(`[${Object.keys(replacements).join("")}]`, "g");
  function serialize_data(fetched, filter, prerendering2 = false) {
    const headers2 = {};
    let cache_control = null;
    let age = null;
    let varyAny = false;
    for (const [key2, value] of fetched.response.headers) {
      if (filter(key2, value)) {
        headers2[key2] = value;
      }
      if (key2 === "cache-control") cache_control = value;
      else if (key2 === "age") age = value;
      else if (key2 === "vary" && value.trim() === "*") varyAny = true;
    }
    const payload = {
      status: fetched.response.status,
      statusText: fetched.response.statusText,
      headers: headers2,
      body: fetched.response_body
    };
    const safe_payload = JSON.stringify(payload).replace(pattern, (match) => replacements[match]);
    const attrs = [
      'type="application/json"',
      "data-sveltekit-fetched",
      `data-url="${escape_html(fetched.url, true)}"`
    ];
    if (fetched.is_b64) {
      attrs.push("data-b64");
    }
    if (fetched.request_headers || fetched.request_body) {
      const values = [];
      if (fetched.request_headers) {
        values.push([
          ...new Headers(fetched.request_headers)
        ].join(","));
      }
      if (fetched.request_body) {
        values.push(fetched.request_body);
      }
      attrs.push(`data-hash="${hash(...values)}"`);
    }
    if (!prerendering2 && fetched.method === "GET" && cache_control && !varyAny) {
      const match = /s-maxage=(\d+)/g.exec(cache_control) ?? /max-age=(\d+)/g.exec(cache_control);
      if (match) {
        const ttl = +match[1] - +(age ?? "0");
        attrs.push(`data-ttl="${ttl}"`);
      }
    }
    return `<script ${attrs.join(" ")}>${safe_payload}<\/script>`;
  }
  const s = JSON.stringify;
  const encoder$2 = new TextEncoder();
  function sha256(data) {
    if (!key[0]) precompute();
    const out = init.slice(0);
    const array2 = encode(data);
    for (let i = 0; i < array2.length; i += 16) {
      const w = array2.subarray(i, i + 16);
      let tmp;
      let a;
      let b;
      let out0 = out[0];
      let out1 = out[1];
      let out2 = out[2];
      let out3 = out[3];
      let out4 = out[4];
      let out5 = out[5];
      let out6 = out[6];
      let out7 = out[7];
      for (let i2 = 0; i2 < 64; i2++) {
        if (i2 < 16) {
          tmp = w[i2];
        } else {
          a = w[i2 + 1 & 15];
          b = w[i2 + 14 & 15];
          tmp = w[i2 & 15] = (a >>> 7 ^ a >>> 18 ^ a >>> 3 ^ a << 25 ^ a << 14) + (b >>> 17 ^ b >>> 19 ^ b >>> 10 ^ b << 15 ^ b << 13) + w[i2 & 15] + w[i2 + 9 & 15] | 0;
        }
        tmp = tmp + out7 + (out4 >>> 6 ^ out4 >>> 11 ^ out4 >>> 25 ^ out4 << 26 ^ out4 << 21 ^ out4 << 7) + (out6 ^ out4 & (out5 ^ out6)) + key[i2];
        out7 = out6;
        out6 = out5;
        out5 = out4;
        out4 = out3 + tmp | 0;
        out3 = out2;
        out2 = out1;
        out1 = out0;
        out0 = tmp + (out1 & out2 ^ out3 & (out1 ^ out2)) + (out1 >>> 2 ^ out1 >>> 13 ^ out1 >>> 22 ^ out1 << 30 ^ out1 << 19 ^ out1 << 10) | 0;
      }
      out[0] = out[0] + out0 | 0;
      out[1] = out[1] + out1 | 0;
      out[2] = out[2] + out2 | 0;
      out[3] = out[3] + out3 | 0;
      out[4] = out[4] + out4 | 0;
      out[5] = out[5] + out5 | 0;
      out[6] = out[6] + out6 | 0;
      out[7] = out[7] + out7 | 0;
    }
    const bytes = new Uint8Array(out.buffer);
    reverse_endianness(bytes);
    return base64(bytes);
  }
  const init = new Uint32Array(8);
  const key = new Uint32Array(64);
  function precompute() {
    function frac(x) {
      return (x - Math.floor(x)) * 4294967296;
    }
    let prime = 2;
    for (let i = 0; i < 64; prime++) {
      let is_prime = true;
      for (let factor = 2; factor * factor <= prime; factor++) {
        if (prime % factor === 0) {
          is_prime = false;
          break;
        }
      }
      if (is_prime) {
        if (i < 8) {
          init[i] = frac(prime ** (1 / 2));
        }
        key[i] = frac(prime ** (1 / 3));
        i++;
      }
    }
  }
  function reverse_endianness(bytes) {
    for (let i = 0; i < bytes.length; i += 4) {
      const a = bytes[i + 0];
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      const d = bytes[i + 3];
      bytes[i + 0] = d;
      bytes[i + 1] = c;
      bytes[i + 2] = b;
      bytes[i + 3] = a;
    }
  }
  function encode(str) {
    const encoded = encoder$2.encode(str);
    const length = encoded.length * 8;
    const size = 512 * Math.ceil((length + 65) / 512);
    const bytes = new Uint8Array(size / 8);
    bytes.set(encoded);
    bytes[encoded.length] = 128;
    reverse_endianness(bytes);
    const words = new Uint32Array(bytes.buffer);
    words[words.length - 2] = Math.floor(length / 4294967296);
    words[words.length - 1] = length;
    return words;
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
  function base64(bytes) {
    const l = bytes.length;
    let result = "";
    let i;
    for (i = 2; i < l; i += 3) {
      result += chars[bytes[i - 2] >> 2];
      result += chars[(bytes[i - 2] & 3) << 4 | bytes[i - 1] >> 4];
      result += chars[(bytes[i - 1] & 15) << 2 | bytes[i] >> 6];
      result += chars[bytes[i] & 63];
    }
    if (i === l + 1) {
      result += chars[bytes[i - 2] >> 2];
      result += chars[(bytes[i - 2] & 3) << 4];
      result += "==";
    }
    if (i === l) {
      result += chars[bytes[i - 2] >> 2];
      result += chars[(bytes[i - 2] & 3) << 4 | bytes[i - 1] >> 4];
      result += chars[(bytes[i - 1] & 15) << 2];
      result += "=";
    }
    return result;
  }
  const array = new Uint8Array(16);
  function generate_nonce() {
    crypto.getRandomValues(array);
    return base64(array);
  }
  const quoted = /* @__PURE__ */ new Set([
    "self",
    "unsafe-eval",
    "unsafe-hashes",
    "unsafe-inline",
    "none",
    "strict-dynamic",
    "report-sample",
    "wasm-unsafe-eval",
    "script"
  ]);
  const crypto_pattern = /^(nonce|sha\d\d\d)-/;
  class BaseProvider {
    #use_hashes;
    #script_needs_csp;
    #script_src_needs_csp;
    #script_src_elem_needs_csp;
    #style_needs_csp;
    #style_src_needs_csp;
    #style_src_attr_needs_csp;
    #style_src_elem_needs_csp;
    #directives;
    #script_src;
    #script_src_elem;
    #style_src;
    #style_src_attr;
    #style_src_elem;
    #nonce;
    constructor(use_hashes, directives, nonce) {
      this.#use_hashes = use_hashes;
      this.#directives = directives;
      const d = this.#directives;
      this.#script_src = [];
      this.#script_src_elem = [];
      this.#style_src = [];
      this.#style_src_attr = [];
      this.#style_src_elem = [];
      const effective_script_src = d["script-src"] || d["default-src"];
      const script_src_elem = d["script-src-elem"];
      const effective_style_src = d["style-src"] || d["default-src"];
      const style_src_attr = d["style-src-attr"];
      const style_src_elem = d["style-src-elem"];
      const needs_csp = (directive) => !!directive && !directive.some((value) => value === "unsafe-inline");
      this.#script_src_needs_csp = needs_csp(effective_script_src);
      this.#script_src_elem_needs_csp = needs_csp(script_src_elem);
      this.#style_src_needs_csp = needs_csp(effective_style_src);
      this.#style_src_attr_needs_csp = needs_csp(style_src_attr);
      this.#style_src_elem_needs_csp = needs_csp(style_src_elem);
      this.#script_needs_csp = this.#script_src_needs_csp || this.#script_src_elem_needs_csp;
      this.#style_needs_csp = this.#style_src_needs_csp || this.#style_src_attr_needs_csp || this.#style_src_elem_needs_csp;
      this.script_needs_nonce = this.#script_needs_csp && !this.#use_hashes;
      this.style_needs_nonce = this.#style_needs_csp && !this.#use_hashes;
      this.#nonce = nonce;
    }
    add_script(content) {
      if (!this.#script_needs_csp) return;
      const source = this.#use_hashes ? `sha256-${sha256(content)}` : `nonce-${this.#nonce}`;
      if (this.#script_src_needs_csp) {
        this.#script_src.push(source);
      }
      if (this.#script_src_elem_needs_csp) {
        this.#script_src_elem.push(source);
      }
    }
    add_style(content) {
      if (!this.#style_needs_csp) return;
      const source = this.#use_hashes ? `sha256-${sha256(content)}` : `nonce-${this.#nonce}`;
      if (this.#style_src_needs_csp) {
        this.#style_src.push(source);
      }
      if (this.#style_src_attr_needs_csp) {
        this.#style_src_attr.push(source);
      }
      if (this.#style_src_elem_needs_csp) {
        const sha256_empty_comment_hash = "sha256-9OlNO0DNEeaVzHL4RZwCLsBHA8WBQ8toBp/4F5XV2nc=";
        const d = this.#directives;
        if (d["style-src-elem"] && !d["style-src-elem"].includes(sha256_empty_comment_hash) && !this.#style_src_elem.includes(sha256_empty_comment_hash)) {
          this.#style_src_elem.push(sha256_empty_comment_hash);
        }
        if (source !== sha256_empty_comment_hash) {
          this.#style_src_elem.push(source);
        }
      }
    }
    get_header(is_meta = false) {
      const header = [];
      const directives = {
        ...this.#directives
      };
      if (this.#style_src.length > 0) {
        directives["style-src"] = [
          ...directives["style-src"] || directives["default-src"] || [],
          ...this.#style_src
        ];
      }
      if (this.#style_src_attr.length > 0) {
        directives["style-src-attr"] = [
          ...directives["style-src-attr"] || [],
          ...this.#style_src_attr
        ];
      }
      if (this.#style_src_elem.length > 0) {
        directives["style-src-elem"] = [
          ...directives["style-src-elem"] || [],
          ...this.#style_src_elem
        ];
      }
      if (this.#script_src.length > 0) {
        directives["script-src"] = [
          ...directives["script-src"] || directives["default-src"] || [],
          ...this.#script_src
        ];
      }
      if (this.#script_src_elem.length > 0) {
        directives["script-src-elem"] = [
          ...directives["script-src-elem"] || [],
          ...this.#script_src_elem
        ];
      }
      for (const key2 in directives) {
        if (is_meta && (key2 === "frame-ancestors" || key2 === "report-uri" || key2 === "sandbox")) {
          continue;
        }
        const value = directives[key2];
        if (!value) continue;
        const directive = [
          key2
        ];
        if (Array.isArray(value)) {
          value.forEach((value2) => {
            if (quoted.has(value2) || crypto_pattern.test(value2)) {
              directive.push(`'${value2}'`);
            } else {
              directive.push(value2);
            }
          });
        }
        header.push(directive.join(" "));
      }
      return header.join("; ");
    }
  }
  class CspProvider extends BaseProvider {
    get_meta() {
      const content = this.get_header(true);
      if (!content) {
        return;
      }
      return `<meta http-equiv="content-security-policy" content="${escape_html(content, true)}">`;
    }
  }
  class CspReportOnlyProvider extends BaseProvider {
    constructor(use_hashes, directives, nonce) {
      super(use_hashes, directives, nonce);
      if (Object.values(directives).filter((v) => !!v).length > 0) {
        const has_report_to = directives["report-to"]?.length ?? 0 > 0;
        const has_report_uri = directives["report-uri"]?.length ?? 0 > 0;
        if (!has_report_to && !has_report_uri) {
          throw Error("`content-security-policy-report-only` must be specified with either the `report-to` or `report-uri` directives, or both");
        }
      }
    }
  }
  class Csp {
    nonce = generate_nonce();
    csp_provider;
    report_only_provider;
    constructor({ mode, directives, reportOnly }, { prerender }) {
      const use_hashes = mode === "hash" || mode === "auto" && prerender;
      this.csp_provider = new CspProvider(use_hashes, directives, this.nonce);
      this.report_only_provider = new CspReportOnlyProvider(use_hashes, reportOnly, this.nonce);
    }
    get script_needs_nonce() {
      return this.csp_provider.script_needs_nonce || this.report_only_provider.script_needs_nonce;
    }
    get style_needs_nonce() {
      return this.csp_provider.style_needs_nonce || this.report_only_provider.style_needs_nonce;
    }
    add_script(content) {
      this.csp_provider.add_script(content);
      this.report_only_provider.add_script(content);
    }
    add_style(content) {
      this.csp_provider.add_style(content);
      this.report_only_provider.add_style(content);
    }
  }
  function defer() {
    let fulfil;
    let reject;
    const promise = new Promise((f, r) => {
      fulfil = f;
      reject = r;
    });
    return {
      promise,
      fulfil,
      reject
    };
  }
  function create_async_iterator() {
    const deferred = [
      defer()
    ];
    return {
      iterator: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              const next = await deferred[0].promise;
              if (!next.done) deferred.shift();
              return next;
            }
          };
        }
      },
      push: (value) => {
        deferred[deferred.length - 1].fulfil({
          value,
          done: false
        });
        deferred.push(defer());
      },
      done: () => {
        deferred[deferred.length - 1].fulfil({
          done: true
        });
      }
    };
  }
  function exec(match, params, matchers) {
    const result = {};
    const values = match.slice(1);
    const values_needing_match = values.filter((value) => value !== void 0);
    let buffered = 0;
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      let value = values[i - buffered];
      if (param.chained && param.rest && buffered) {
        value = values.slice(i - buffered, i + 1).filter((s2) => s2).join("/");
        buffered = 0;
      }
      if (value === void 0) {
        if (param.rest) result[param.name] = "";
        continue;
      }
      if (!param.matcher || matchers[param.matcher](value)) {
        result[param.name] = value;
        const next_param = params[i + 1];
        const next_value = values[i + 1];
        if (next_param && !next_param.rest && next_param.optional && next_value && param.chained) {
          buffered = 0;
        }
        if (!next_param && !next_value && Object.keys(result).length === values_needing_match.length) {
          buffered = 0;
        }
        continue;
      }
      if (param.optional && param.chained) {
        buffered++;
        continue;
      }
      return;
    }
    if (buffered) return;
    return result;
  }
  function generate_route_object(route, url, manifest) {
    const { errors, layouts, leaf } = route;
    const nodes = [
      ...errors,
      ...layouts.map((l) => l?.[1]),
      leaf[1]
    ].filter((n) => typeof n === "number").map((n) => `'${n}': () => ${create_client_import(manifest._.client.nodes?.[n], url)}`).join(",\n		");
    return [
      `{
	id: ${s(route.id)}`,
      `errors: ${s(route.errors)}`,
      `layouts: ${s(route.layouts)}`,
      `leaf: ${s(route.leaf)}`,
      `nodes: {
		${nodes}
	}
}`
    ].join(",\n	");
  }
  function create_client_import(import_path, url) {
    if (!import_path) return "Promise.resolve({})";
    if (import_path[0] === "/") {
      return `import('${import_path}')`;
    }
    if (assets !== "") {
      return `import('${assets}/${import_path}')`;
    }
    let path = get_relative_path(url.pathname, `${base}/${import_path}`);
    if (path[0] !== ".") path = `./${path}`;
    return `import('${path}')`;
  }
  async function resolve_route(resolved_path, url, manifest) {
    if (!manifest._.client.routes) {
      return text("Server-side route resolution disabled", {
        status: 400
      });
    }
    let route = null;
    let params = {};
    const matchers = await manifest._.matchers();
    for (const candidate of manifest._.client.routes) {
      const match = candidate.pattern.exec(resolved_path);
      if (!match) continue;
      const matched = exec(match, candidate.params, matchers);
      if (matched) {
        route = candidate;
        params = decode_params(matched);
        break;
      }
    }
    return create_server_routing_response(route, params, url, manifest).response;
  }
  function create_server_routing_response(route, params, url, manifest) {
    const headers2 = new Headers({
      "content-type": "application/javascript; charset=utf-8"
    });
    if (route) {
      const csr_route = generate_route_object(route, url, manifest);
      const body2 = `${create_css_import(route, url, manifest)}
export const route = ${csr_route}; export const params = ${JSON.stringify(params)};`;
      return {
        response: text(body2, {
          headers: headers2
        }),
        body: body2
      };
    } else {
      return {
        response: text("", {
          headers: headers2
        }),
        body: ""
      };
    }
  }
  function create_css_import(route, url, manifest) {
    const { errors, layouts, leaf } = route;
    let css = "";
    for (const node of [
      ...errors,
      ...layouts.map((l) => l?.[1]),
      leaf[1]
    ]) {
      if (typeof node !== "number") continue;
      const node_css = manifest._.client.css?.[node];
      for (const css_path of node_css ?? []) {
        css += `'${assets || base}/${css_path}',`;
      }
    }
    if (!css) return "";
    return `${create_client_import(manifest._.client.start, url)}.then(x => x.load_css([${css}]));`;
  }
  const updated = {
    ...readable(false),
    check: () => false
  };
  const encoder$1 = new TextEncoder();
  async function render_response({ branch, fetched, options: options2, manifest, state, page_config, status, error = null, event, resolve_opts, action_result }) {
    if (state.prerendering) {
      if (options2.csp.mode === "nonce") {
        throw new Error('Cannot use prerendering if config.kit.csp.mode === "nonce"');
      }
      if (options2.app_template_contains_nonce) {
        throw new Error("Cannot use prerendering if page template contains %sveltekit.nonce%");
      }
    }
    const { client } = manifest._;
    const modulepreloads = new Set(client.imports);
    const stylesheets = new Set(client.stylesheets);
    const fonts = new Set(client.fonts);
    const link_header_preloads = /* @__PURE__ */ new Set();
    const inline_styles = /* @__PURE__ */ new Map();
    let rendered;
    const form_value = action_result?.type === "success" || action_result?.type === "failure" ? action_result.data ?? null : null;
    let base$1 = base;
    let assets$1 = assets;
    let base_expression = s(base);
    {
      if (!state.prerendering?.fallback) {
        const segments = event.url.pathname.slice(base.length).split("/").slice(2);
        base$1 = segments.map(() => "..").join("/") || ".";
        base_expression = `new URL(${s(base$1)}, location).pathname.slice(0, -1)`;
        if (!assets || assets[0] === "/" && assets !== SVELTE_KIT_ASSETS) {
          assets$1 = base$1;
        }
      } else if (options2.hash_routing) {
        base_expression = "new URL('.', location).pathname.slice(0, -1)";
      }
    }
    if (page_config.ssr) {
      const props = {
        stores: {
          page: writable(null),
          navigating: writable(null),
          updated
        },
        constructors: await Promise.all(branch.map(({ node }) => {
          if (!node.component) {
            throw new Error(`Missing +page.svelte component for route ${event.route.id}`);
          }
          return node.component();
        })),
        form: form_value
      };
      let data2 = {};
      for (let i = 0; i < branch.length; i += 1) {
        data2 = {
          ...data2,
          ...branch[i].data
        };
        props[`data_${i}`] = data2;
      }
      props.page = {
        error,
        params: event.params,
        route: event.route,
        status,
        url: event.url,
        data: data2,
        form: form_value,
        state: {}
      };
      override({
        base: base$1,
        assets: assets$1
      });
      const render_opts = {
        context: /* @__PURE__ */ new Map([
          [
            "__request__",
            {
              page: props.page
            }
          ]
        ])
      };
      {
        try {
          rendered = options2.root.render(props, render_opts);
        } finally {
          reset();
        }
      }
      for (const { node } of branch) {
        for (const url of node.imports) modulepreloads.add(url);
        for (const url of node.stylesheets) stylesheets.add(url);
        for (const url of node.fonts) fonts.add(url);
        if (node.inline_styles && !client.inline) {
          Object.entries(await node.inline_styles()).forEach(([k, v]) => inline_styles.set(k, v));
        }
      }
    } else {
      rendered = {
        head: "",
        html: "",
        css: {
          code: "",
          map: null
        }
      };
    }
    let head = "";
    let body2 = rendered.html;
    const csp = new Csp(options2.csp, {
      prerender: !!state.prerendering
    });
    const prefixed = (path) => {
      if (path.startsWith("/")) {
        return base + path;
      }
      return `${assets$1}/${path}`;
    };
    const style = client.inline ? client.inline?.style : Array.from(inline_styles.values()).join("\n");
    if (style) {
      const attributes = [];
      if (csp.style_needs_nonce) attributes.push(` nonce="${csp.nonce}"`);
      csp.add_style(style);
      head += `
	<style${attributes.join("")}>${style}</style>`;
    }
    for (const dep of stylesheets) {
      const path = prefixed(dep);
      const attributes = [
        'rel="stylesheet"'
      ];
      if (inline_styles.has(dep)) {
        attributes.push("disabled", 'media="(max-width: 0)"');
      } else {
        if (resolve_opts.preload({
          type: "css",
          path
        })) {
          const preload_atts = [
            'rel="preload"',
            'as="style"'
          ];
          link_header_preloads.add(`<${encodeURI(path)}>; ${preload_atts.join(";")}; nopush`);
        }
      }
      head += `
		<link href="${path}" ${attributes.join(" ")}>`;
    }
    for (const dep of fonts) {
      const path = prefixed(dep);
      if (resolve_opts.preload({
        type: "font",
        path
      })) {
        const ext = dep.slice(dep.lastIndexOf(".") + 1);
        const attributes = [
          'rel="preload"',
          'as="font"',
          `type="font/${ext}"`,
          `href="${path}"`,
          "crossorigin"
        ];
        head += `
		<link ${attributes.join(" ")}>`;
      }
    }
    const global = `__sveltekit_${options2.version_hash}`;
    const { data, chunks } = get_data(event, options2, branch.map((b) => b.server_data), csp, global);
    if (page_config.ssr && page_config.csr) {
      body2 += `
			${fetched.map((item) => serialize_data(item, resolve_opts.filterSerializedResponseHeaders, !!state.prerendering)).join("\n			")}`;
    }
    if (page_config.csr) {
      const route = manifest._.client.routes?.find((r) => r.id === event.route.id) ?? null;
      if (client.uses_env_dynamic_public && state.prerendering) {
        modulepreloads.add(`${app_dir}/env.js`);
      }
      if (!client.inline) {
        const included_modulepreloads = Array.from(modulepreloads, (dep) => prefixed(dep)).filter((path) => resolve_opts.preload({
          type: "js",
          path
        }));
        for (const path of included_modulepreloads) {
          link_header_preloads.add(`<${encodeURI(path)}>; rel="modulepreload"; nopush`);
          if (options2.preload_strategy !== "modulepreload") {
            head += `
		<link rel="preload" as="script" crossorigin="anonymous" href="${path}">`;
          } else if (state.prerendering) {
            head += `
		<link rel="modulepreload" href="${path}">`;
          }
        }
      }
      if (manifest._.client.routes && state.prerendering && !state.prerendering.fallback) {
        const pathname = add_resolution_suffix(event.url.pathname);
        state.prerendering.dependencies.set(pathname, create_server_routing_response(route, event.params, new URL(pathname, event.url), manifest));
      }
      const blocks = [];
      const load_env_eagerly = client.uses_env_dynamic_public && state.prerendering;
      const properties = [
        `base: ${base_expression}`
      ];
      if (assets) {
        properties.push(`assets: ${s(assets)}`);
      }
      if (client.uses_env_dynamic_public) {
        properties.push(`env: ${load_env_eagerly ? "null" : s(public_env)}`);
      }
      if (chunks) {
        blocks.push("const deferred = new Map();");
        properties.push(`defer: (id) => new Promise((fulfil, reject) => {
							deferred.set(id, { fulfil, reject });
						})`);
        properties.push(`resolve: ({ id, data, error }) => {
							const try_to_resolve = () => {
								if (!deferred.has(id)) {
									setTimeout(try_to_resolve, 0);
									return;
								}
								const { fulfil, reject } = deferred.get(id);
								deferred.delete(id);
								if (error) reject(error);
								else fulfil(data);
							}
							try_to_resolve();
						}`);
      }
      blocks.push(`${global} = {
						${properties.join(",\n						")}
					};`);
      const args = [
        "element"
      ];
      blocks.push("const element = document.currentScript.parentElement;");
      if (page_config.ssr) {
        const serialized = {
          form: "null",
          error: "null"
        };
        if (form_value) {
          serialized.form = uneval_action_response(form_value, event.route.id, options2.hooks.transport);
        }
        if (error) {
          serialized.error = uneval(error);
        }
        const hydrate = [
          `node_ids: [${branch.map(({ node }) => node.index).join(", ")}]`,
          `data: ${data}`,
          `form: ${serialized.form}`,
          `error: ${serialized.error}`
        ];
        if (status !== 200) {
          hydrate.push(`status: ${status}`);
        }
        if (manifest._.client.routes) {
          if (route) {
            const stringified = generate_route_object(route, event.url, manifest).replaceAll("\n", "\n							");
            hydrate.push(`params: ${uneval(event.params)}`, `server_route: ${stringified}`);
          }
        } else if (options2.embedded) {
          hydrate.push(`params: ${uneval(event.params)}`, `route: ${s(event.route)}`);
        }
        const indent = "	".repeat(load_env_eagerly ? 7 : 6);
        args.push(`{
${indent}	${hydrate.join(`,
${indent}	`)}
${indent}}`);
      }
      const boot = client.inline ? `${client.inline.script}

					__sveltekit_${options2.version_hash}.app.start(${args.join(", ")});` : client.app ? `Promise.all([
						import(${s(prefixed(client.start))}),
						import(${s(prefixed(client.app))})
					]).then(([kit, app]) => {
						kit.start(app, ${args.join(", ")});
					});` : `import(${s(prefixed(client.start))}).then((app) => {
						app.start(${args.join(", ")})
					});`;
      if (load_env_eagerly) {
        blocks.push(`import(${s(`${base$1}/${app_dir}/env.js`)}).then(({ env }) => {
						${global}.env = env;

						${boot.replace(/\n/g, "\n	")}
					});`);
      } else {
        blocks.push(boot);
      }
      if (options2.service_worker) {
        const opts = "";
        blocks.push(`if ('serviceWorker' in navigator) {
						addEventListener('load', function () {
							navigator.serviceWorker.register('${prefixed("service-worker.js")}'${opts});
						});
					}`);
      }
      const init_app = `
				{
					${blocks.join("\n\n					")}
				}
			`;
      csp.add_script(init_app);
      body2 += `
			<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>${init_app}<\/script>
		`;
    }
    const headers2 = new Headers({
      "x-sveltekit-page": "true",
      "content-type": "text/html"
    });
    if (state.prerendering) {
      const http_equiv = [];
      const csp_headers = csp.csp_provider.get_meta();
      if (csp_headers) {
        http_equiv.push(csp_headers);
      }
      if (state.prerendering.cache) {
        http_equiv.push(`<meta http-equiv="cache-control" content="${state.prerendering.cache}">`);
      }
      if (http_equiv.length > 0) {
        head = http_equiv.join("\n") + head;
      }
    } else {
      const csp_header = csp.csp_provider.get_header();
      if (csp_header) {
        headers2.set("content-security-policy", csp_header);
      }
      const report_only_header = csp.report_only_provider.get_header();
      if (report_only_header) {
        headers2.set("content-security-policy-report-only", report_only_header);
      }
      if (link_header_preloads.size) {
        headers2.set("link", Array.from(link_header_preloads).join(", "));
      }
    }
    head += rendered.head;
    const html = options2.templates.app({
      head,
      body: body2,
      assets: assets$1,
      nonce: csp.nonce,
      env: safe_public_env
    });
    const transformed = await resolve_opts.transformPageChunk({
      html,
      done: true
    }) || "";
    if (!chunks) {
      headers2.set("etag", `"${hash(transformed)}"`);
    }
    return !chunks ? text(transformed, {
      status,
      headers: headers2
    }) : new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder$1.encode(transformed + "\n"));
        for await (const chunk of chunks) {
          controller.enqueue(encoder$1.encode(chunk));
        }
        controller.close();
      },
      type: "bytes"
    }), {
      headers: headers2
    });
  }
  function get_data(event, options2, nodes, csp, global) {
    let promise_id = 1;
    let count = 0;
    const { iterator, push, done } = create_async_iterator();
    function replacer(thing) {
      if (typeof thing?.then === "function") {
        const id = promise_id++;
        count += 1;
        thing.then((data) => ({
          data
        })).catch(async (error) => ({
          error: await handle_error_and_jsonify(event, options2, error)
        })).then(async ({ data, error }) => {
          count -= 1;
          let str;
          try {
            str = uneval({
              id,
              data,
              error
            }, replacer);
          } catch {
            error = await handle_error_and_jsonify(event, options2, new Error(`Failed to serialize promise while rendering ${event.route.id}`));
            data = void 0;
            str = uneval({
              id,
              data,
              error
            }, replacer);
          }
          const nonce = csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : "";
          push(`<script${nonce}>${global}.resolve(${str})<\/script>
`);
          if (count === 0) done();
        });
        return `${global}.defer(${id})`;
      } else {
        for (const key2 in options2.hooks.transport) {
          const encoded = options2.hooks.transport[key2].encode(thing);
          if (encoded) {
            return `app.decode('${key2}', ${uneval(encoded, replacer)})`;
          }
        }
      }
    }
    try {
      const strings = nodes.map((node) => {
        if (!node) return "null";
        return `{"type":"data","data":${uneval(node.data, replacer)},${stringify_uses(node)}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ""}}`;
      });
      return {
        data: `[${strings.join(",")}]`,
        chunks: count > 0 ? iterator : null
      };
    } catch (e) {
      throw new Error(clarify_devalue_error(event, e));
    }
  }
  class PageNodes {
    data;
    constructor(nodes) {
      this.data = nodes;
    }
    layouts() {
      return this.data.slice(0, -1);
    }
    page() {
      return this.data.at(-1);
    }
    validate() {
      for (const layout of this.layouts()) {
        if (layout) {
          validate_layout_server_exports(layout.server, layout.server_id);
          validate_layout_exports(layout.universal, layout.universal_id);
        }
      }
      const page = this.page();
      if (page) {
        validate_page_server_exports(page.server, page.server_id);
        validate_page_exports(page.universal, page.universal_id);
      }
    }
    #get_option(option) {
      return this.data.reduce((value, node) => {
        return node?.universal?.[option] ?? node?.server?.[option] ?? value;
      }, void 0);
    }
    csr() {
      return this.#get_option("csr") ?? true;
    }
    ssr() {
      return this.#get_option("ssr") ?? true;
    }
    prerender() {
      return this.#get_option("prerender") ?? false;
    }
    trailing_slash() {
      return this.#get_option("trailingSlash") ?? "never";
    }
    get_config() {
      let current = {};
      for (const node of this.data) {
        if (!node?.universal?.config && !node?.server?.config) continue;
        current = {
          ...current,
          ...node?.universal?.config,
          ...node?.server?.config
        };
      }
      return Object.keys(current).length ? current : void 0;
    }
    should_prerender_data() {
      return this.data.some((node) => node?.server?.load || node?.server?.trailingSlash !== void 0);
    }
  }
  async function respond_with_error({ event, options: options2, manifest, state, status, error, resolve_opts }) {
    if (event.request.headers.get("x-sveltekit-error")) {
      return static_error_page(options2, status, error.message);
    }
    const fetched = [];
    try {
      const branch = [];
      const default_layout = await manifest._.nodes[0]();
      const nodes = new PageNodes([
        default_layout
      ]);
      const ssr = nodes.ssr();
      const csr = nodes.csr();
      if (ssr) {
        state.error = true;
        const server_data_promise = load_server_data({
          event,
          state,
          node: default_layout,
          parent: async () => ({})
        });
        const server_data = await server_data_promise;
        const data = await load_data({
          event,
          fetched,
          node: default_layout,
          parent: async () => ({}),
          resolve_opts,
          server_data_promise,
          state,
          csr
        });
        branch.push({
          node: default_layout,
          server_data,
          data
        }, {
          node: await manifest._.nodes[1](),
          data: null,
          server_data: null
        });
      }
      return await render_response({
        options: options2,
        manifest,
        state,
        page_config: {
          ssr,
          csr
        },
        status,
        error: await handle_error_and_jsonify(event, options2, error),
        branch,
        fetched,
        event,
        resolve_opts
      });
    } catch (e) {
      if (e instanceof Redirect) {
        return redirect_response(e.status, e.location);
      }
      return static_error_page(options2, get_status(e), (await handle_error_and_jsonify(event, options2, e)).message);
    }
  }
  function once(fn) {
    let done = false;
    let result;
    return () => {
      if (done) return result;
      done = true;
      return result = fn();
    };
  }
  const encoder = new TextEncoder();
  async function render_data(event, route, options2, manifest, state, invalidated_data_nodes, trailing_slash) {
    if (!route.page) {
      return new Response(void 0, {
        status: 404
      });
    }
    try {
      const node_ids = [
        ...route.page.layouts,
        route.page.leaf
      ];
      const invalidated = invalidated_data_nodes ?? node_ids.map(() => true);
      let aborted = false;
      const url = new URL(event.url);
      url.pathname = normalize_path(url.pathname, trailing_slash);
      const new_event = {
        ...event,
        url
      };
      const functions = node_ids.map((n, i) => {
        return once(async () => {
          try {
            if (aborted) {
              return {
                type: "skip"
              };
            }
            const node = n == void 0 ? n : await manifest._.nodes[n]();
            return load_server_data({
              event: new_event,
              state,
              node,
              parent: async () => {
                const data2 = {};
                for (let j = 0; j < i; j += 1) {
                  const parent = await functions[j]();
                  if (parent) {
                    Object.assign(data2, parent.data);
                  }
                }
                return data2;
              }
            });
          } catch (e) {
            aborted = true;
            throw e;
          }
        });
      });
      const promises = functions.map(async (fn, i) => {
        if (!invalidated[i]) {
          return {
            type: "skip"
          };
        }
        return fn();
      });
      let length = promises.length;
      const nodes = await Promise.all(promises.map((p, i) => p.catch(async (error) => {
        if (error instanceof Redirect) {
          throw error;
        }
        length = Math.min(length, i + 1);
        return {
          type: "error",
          error: await handle_error_and_jsonify(event, options2, error),
          status: error instanceof HttpError || error instanceof SvelteKitError ? error.status : void 0
        };
      })));
      const { data, chunks } = get_data_json(event, options2, nodes);
      if (!chunks) {
        return json_response(data);
      }
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(data));
          for await (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
        type: "bytes"
      }), {
        headers: {
          "content-type": "text/sveltekit-data",
          "cache-control": "private, no-store"
        }
      });
    } catch (e) {
      const error = normalize_error(e);
      if (error instanceof Redirect) {
        return redirect_json_response(error);
      } else {
        return json_response(await handle_error_and_jsonify(event, options2, error), 500);
      }
    }
  }
  function json_response(json2, status = 200) {
    return text(typeof json2 === "string" ? json2 : JSON.stringify(json2), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store"
      }
    });
  }
  function redirect_json_response(redirect) {
    return json_response({
      type: "redirect",
      location: redirect.location
    });
  }
  function get_data_json(event, options2, nodes) {
    let promise_id = 1;
    let count = 0;
    const { iterator, push, done } = create_async_iterator();
    const reducers = {
      ...Object.fromEntries(Object.entries(options2.hooks.transport).map(([key2, value]) => [
        key2,
        value.encode
      ])),
      Promise: (thing) => {
        if (typeof thing?.then === "function") {
          const id = promise_id++;
          count += 1;
          let key2 = "data";
          thing.catch(async (e) => {
            key2 = "error";
            return handle_error_and_jsonify(event, options2, e);
          }).then(async (value) => {
            let str;
            try {
              str = stringify(value, reducers);
            } catch {
              const error = await handle_error_and_jsonify(event, options2, new Error(`Failed to serialize promise while rendering ${event.route.id}`));
              key2 = "error";
              str = stringify(error, reducers);
            }
            count -= 1;
            push(`{"type":"chunk","id":${id},"${key2}":${str}}
`);
            if (count === 0) done();
          });
          return id;
        }
      }
    };
    try {
      const strings = nodes.map((node) => {
        if (!node) return "null";
        if (node.type === "error" || node.type === "skip") {
          return JSON.stringify(node);
        }
        return `{"type":"data","data":${stringify(node.data, reducers)},${stringify_uses(node)}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ""}}`;
      });
      return {
        data: `{"type":"data","nodes":[${strings.join(",")}]}
`,
        chunks: count > 0 ? iterator : null
      };
    } catch (e) {
      throw new Error(clarify_devalue_error(event, e));
    }
  }
  const MAX_DEPTH = 10;
  async function render_page(event, page, options2, manifest, state, nodes, resolve_opts) {
    if (state.depth > MAX_DEPTH) {
      return text(`Not found: ${event.url.pathname}`, {
        status: 404
      });
    }
    if (is_action_json_request(event)) {
      const node = await manifest._.nodes[page.leaf]();
      return handle_action_json_request(event, options2, node?.server);
    }
    try {
      const leaf_node = nodes.page();
      let status = 200;
      let action_result = void 0;
      if (is_action_request(event)) {
        action_result = await handle_action_request(event, leaf_node.server);
        if (action_result?.type === "redirect") {
          return redirect_response(action_result.status, action_result.location);
        }
        if (action_result?.type === "error") {
          status = get_status(action_result.error);
        }
        if (action_result?.type === "failure") {
          status = action_result.status;
        }
      }
      const should_prerender = nodes.prerender();
      if (should_prerender) {
        const mod = leaf_node.server;
        if (mod?.actions) {
          throw new Error("Cannot prerender pages with actions");
        }
      } else if (state.prerendering) {
        return new Response(void 0, {
          status: 204
        });
      }
      state.prerender_default = should_prerender;
      const should_prerender_data = nodes.should_prerender_data();
      const data_pathname = add_data_suffix(event.url.pathname);
      const fetched = [];
      if (nodes.ssr() === false && !(state.prerendering && should_prerender_data)) {
        if (DEV && action_result && !event.request.headers.has("x-sveltekit-action")) ;
        return await render_response({
          branch: [],
          fetched,
          page_config: {
            ssr: false,
            csr: nodes.csr()
          },
          status,
          error: null,
          event,
          options: options2,
          manifest,
          state,
          resolve_opts
        });
      }
      const branch = [];
      let load_error = null;
      const server_promises = nodes.data.map((node, i) => {
        if (load_error) {
          throw load_error;
        }
        return Promise.resolve().then(async () => {
          try {
            if (node === leaf_node && action_result?.type === "error") {
              throw action_result.error;
            }
            return await load_server_data({
              event,
              state,
              node,
              parent: async () => {
                const data = {};
                for (let j = 0; j < i; j += 1) {
                  const parent = await server_promises[j];
                  if (parent) Object.assign(data, parent.data);
                }
                return data;
              }
            });
          } catch (e) {
            load_error = e;
            throw load_error;
          }
        });
      });
      const csr = nodes.csr();
      const load_promises = nodes.data.map((node, i) => {
        if (load_error) throw load_error;
        return Promise.resolve().then(async () => {
          try {
            return await load_data({
              event,
              fetched,
              node,
              parent: async () => {
                const data = {};
                for (let j = 0; j < i; j += 1) {
                  Object.assign(data, await load_promises[j]);
                }
                return data;
              },
              resolve_opts,
              server_data_promise: server_promises[i],
              state,
              csr
            });
          } catch (e) {
            load_error = e;
            throw load_error;
          }
        });
      });
      for (const p of server_promises) p.catch(() => {
      });
      for (const p of load_promises) p.catch(() => {
      });
      for (let i = 0; i < nodes.data.length; i += 1) {
        const node = nodes.data[i];
        if (node) {
          try {
            const server_data = await server_promises[i];
            const data = await load_promises[i];
            branch.push({
              node,
              server_data,
              data
            });
          } catch (e) {
            const err = normalize_error(e);
            if (err instanceof Redirect) {
              if (state.prerendering && should_prerender_data) {
                const body2 = JSON.stringify({
                  type: "redirect",
                  location: err.location
                });
                state.prerendering.dependencies.set(data_pathname, {
                  response: text(body2),
                  body: body2
                });
              }
              return redirect_response(err.status, err.location);
            }
            const status2 = get_status(err);
            const error = await handle_error_and_jsonify(event, options2, err);
            while (i--) {
              if (page.errors[i]) {
                const index = page.errors[i];
                const node2 = await manifest._.nodes[index]();
                let j = i;
                while (!branch[j]) j -= 1;
                return await render_response({
                  event,
                  options: options2,
                  manifest,
                  state,
                  resolve_opts,
                  page_config: {
                    ssr: true,
                    csr: true
                  },
                  status: status2,
                  error,
                  branch: compact(branch.slice(0, j + 1)).concat({
                    node: node2,
                    data: null,
                    server_data: null
                  }),
                  fetched
                });
              }
            }
            return static_error_page(options2, status2, error.message);
          }
        } else {
          branch.push(null);
        }
      }
      if (state.prerendering && should_prerender_data) {
        let { data, chunks } = get_data_json(event, options2, branch.map((node) => node?.server_data));
        if (chunks) {
          for await (const chunk of chunks) {
            data += chunk;
          }
        }
        state.prerendering.dependencies.set(data_pathname, {
          response: text(data),
          body: data
        });
      }
      const ssr = nodes.ssr();
      return await render_response({
        event,
        options: options2,
        manifest,
        state,
        resolve_opts,
        page_config: {
          csr: nodes.csr(),
          ssr
        },
        status,
        error: null,
        branch: ssr === false ? [] : compact(branch),
        action_result,
        fetched
      });
    } catch (e) {
      return await respond_with_error({
        event,
        options: options2,
        manifest,
        state,
        status: 500,
        error: e,
        resolve_opts
      });
    }
  }
  var cookie = {};
  var hasRequiredCookie;
  function requireCookie() {
    if (hasRequiredCookie) return cookie;
    hasRequiredCookie = 1;
    cookie.parse = parse;
    cookie.serialize = serialize;
    var __toString = Object.prototype.toString;
    var fieldContentRegExp = /^[\u0009\u0020-\u007e\u0080-\u00ff]+$/;
    function parse(str, options2) {
      if (typeof str !== "string") {
        throw new TypeError("argument str must be a string");
      }
      var obj = {};
      var opt = options2 || {};
      var dec = opt.decode || decode;
      var index = 0;
      while (index < str.length) {
        var eqIdx = str.indexOf("=", index);
        if (eqIdx === -1) {
          break;
        }
        var endIdx = str.indexOf(";", index);
        if (endIdx === -1) {
          endIdx = str.length;
        } else if (endIdx < eqIdx) {
          index = str.lastIndexOf(";", eqIdx - 1) + 1;
          continue;
        }
        var key2 = str.slice(index, eqIdx).trim();
        if (void 0 === obj[key2]) {
          var val = str.slice(eqIdx + 1, endIdx).trim();
          if (val.charCodeAt(0) === 34) {
            val = val.slice(1, -1);
          }
          obj[key2] = tryDecode(val, dec);
        }
        index = endIdx + 1;
      }
      return obj;
    }
    function serialize(name, val, options2) {
      var opt = options2 || {};
      var enc = opt.encode || encode2;
      if (typeof enc !== "function") {
        throw new TypeError("option encode is invalid");
      }
      if (!fieldContentRegExp.test(name)) {
        throw new TypeError("argument name is invalid");
      }
      var value = enc(val);
      if (value && !fieldContentRegExp.test(value)) {
        throw new TypeError("argument val is invalid");
      }
      var str = name + "=" + value;
      if (null != opt.maxAge) {
        var maxAge = opt.maxAge - 0;
        if (isNaN(maxAge) || !isFinite(maxAge)) {
          throw new TypeError("option maxAge is invalid");
        }
        str += "; Max-Age=" + Math.floor(maxAge);
      }
      if (opt.domain) {
        if (!fieldContentRegExp.test(opt.domain)) {
          throw new TypeError("option domain is invalid");
        }
        str += "; Domain=" + opt.domain;
      }
      if (opt.path) {
        if (!fieldContentRegExp.test(opt.path)) {
          throw new TypeError("option path is invalid");
        }
        str += "; Path=" + opt.path;
      }
      if (opt.expires) {
        var expires = opt.expires;
        if (!isDate(expires) || isNaN(expires.valueOf())) {
          throw new TypeError("option expires is invalid");
        }
        str += "; Expires=" + expires.toUTCString();
      }
      if (opt.httpOnly) {
        str += "; HttpOnly";
      }
      if (opt.secure) {
        str += "; Secure";
      }
      if (opt.partitioned) {
        str += "; Partitioned";
      }
      if (opt.priority) {
        var priority = typeof opt.priority === "string" ? opt.priority.toLowerCase() : opt.priority;
        switch (priority) {
          case "low":
            str += "; Priority=Low";
            break;
          case "medium":
            str += "; Priority=Medium";
            break;
          case "high":
            str += "; Priority=High";
            break;
          default:
            throw new TypeError("option priority is invalid");
        }
      }
      if (opt.sameSite) {
        var sameSite = typeof opt.sameSite === "string" ? opt.sameSite.toLowerCase() : opt.sameSite;
        switch (sameSite) {
          case true:
            str += "; SameSite=Strict";
            break;
          case "lax":
            str += "; SameSite=Lax";
            break;
          case "strict":
            str += "; SameSite=Strict";
            break;
          case "none":
            str += "; SameSite=None";
            break;
          default:
            throw new TypeError("option sameSite is invalid");
        }
      }
      return str;
    }
    function decode(str) {
      return str.indexOf("%") !== -1 ? decodeURIComponent(str) : str;
    }
    function encode2(val) {
      return encodeURIComponent(val);
    }
    function isDate(val) {
      return __toString.call(val) === "[object Date]" || val instanceof Date;
    }
    function tryDecode(str, decode2) {
      try {
        return decode2(str);
      } catch (e) {
        return str;
      }
    }
    return cookie;
  }
  var cookieExports = requireCookie();
  const INVALID_COOKIE_CHARACTER_REGEX = /[\x00-\x1F\x7F()<>@,;:"/[\]?={} \t]/;
  function validate_options(options2) {
    if (options2?.path === void 0) {
      throw new Error("You must specify a `path` when setting, deleting or serializing cookies");
    }
  }
  function get_cookies(request, url) {
    const header = request.headers.get("cookie") ?? "";
    const initial_cookies = cookieExports.parse(header, {
      decode: (value) => value
    });
    let normalized_url;
    const new_cookies = {};
    const defaults = {
      httpOnly: true,
      sameSite: "lax",
      secure: url.hostname === "localhost" && url.protocol === "http:" ? false : true
    };
    const cookies = {
      get(name, opts) {
        const c = new_cookies[name];
        if (c && domain_matches(url.hostname, c.options.domain) && path_matches(url.pathname, c.options.path)) {
          return c.value;
        }
        const req_cookies = cookieExports.parse(header, {
          decode: opts?.decode
        });
        const cookie2 = req_cookies[name];
        return cookie2;
      },
      getAll(opts) {
        const cookies2 = cookieExports.parse(header, {
          decode: opts?.decode
        });
        for (const c of Object.values(new_cookies)) {
          if (domain_matches(url.hostname, c.options.domain) && path_matches(url.pathname, c.options.path)) {
            cookies2[c.name] = c.value;
          }
        }
        return Object.entries(cookies2).map(([name, value]) => ({
          name,
          value
        }));
      },
      set(name, value, options2) {
        const illegal_characters = name.match(INVALID_COOKIE_CHARACTER_REGEX);
        if (illegal_characters) {
          console.warn(`The cookie name "${name}" will be invalid in SvelteKit 3.0 as it contains ${illegal_characters.join(" and ")}. See RFC 2616 for more details https://datatracker.ietf.org/doc/html/rfc2616#section-2.2`);
        }
        validate_options(options2);
        set_internal(name, value, {
          ...defaults,
          ...options2
        });
      },
      delete(name, options2) {
        validate_options(options2);
        cookies.set(name, "", {
          ...options2,
          maxAge: 0
        });
      },
      serialize(name, value, options2) {
        validate_options(options2);
        let path = options2.path;
        if (!options2.domain || options2.domain === url.hostname) {
          if (!normalized_url) {
            throw new Error("Cannot serialize cookies until after the route is determined");
          }
          path = resolve(normalized_url, path);
        }
        return cookieExports.serialize(name, value, {
          ...defaults,
          ...options2,
          path
        });
      }
    };
    function get_cookie_header(destination, header2) {
      const combined_cookies = {
        ...initial_cookies
      };
      for (const key2 in new_cookies) {
        const cookie2 = new_cookies[key2];
        if (!domain_matches(destination.hostname, cookie2.options.domain)) continue;
        if (!path_matches(destination.pathname, cookie2.options.path)) continue;
        const encoder2 = cookie2.options.encode || encodeURIComponent;
        combined_cookies[cookie2.name] = encoder2(cookie2.value);
      }
      if (header2) {
        const parsed = cookieExports.parse(header2, {
          decode: (value) => value
        });
        for (const name in parsed) {
          combined_cookies[name] = parsed[name];
        }
      }
      return Object.entries(combined_cookies).map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const internal_queue = [];
    function set_internal(name, value, options2) {
      if (!normalized_url) {
        internal_queue.push(() => set_internal(name, value, options2));
        return;
      }
      let path = options2.path;
      if (!options2.domain || options2.domain === url.hostname) {
        path = resolve(normalized_url, path);
      }
      new_cookies[name] = {
        name,
        value,
        options: {
          ...options2,
          path
        }
      };
    }
    function set_trailing_slash(trailing_slash) {
      normalized_url = normalize_path(url.pathname, trailing_slash);
      internal_queue.forEach((fn) => fn());
    }
    return {
      cookies,
      new_cookies,
      get_cookie_header,
      set_internal,
      set_trailing_slash
    };
  }
  function domain_matches(hostname, constraint) {
    if (!constraint) return true;
    const normalized = constraint[0] === "." ? constraint.slice(1) : constraint;
    if (hostname === normalized) return true;
    return hostname.endsWith("." + normalized);
  }
  function path_matches(path, constraint) {
    if (!constraint) return true;
    const normalized = constraint.endsWith("/") ? constraint.slice(0, -1) : constraint;
    if (path === normalized) return true;
    return path.startsWith(normalized + "/");
  }
  function add_cookies_to_headers(headers2, cookies) {
    for (const new_cookie of cookies) {
      const { name, value, options: options2 } = new_cookie;
      headers2.append("set-cookie", cookieExports.serialize(name, value, options2));
      if (options2.path.endsWith(".html")) {
        const path = add_data_suffix(options2.path);
        headers2.append("set-cookie", cookieExports.serialize(name, value, {
          ...options2,
          path
        }));
      }
    }
  }
  var setCookie = {
    exports: {}
  };
  var hasRequiredSetCookie;
  function requireSetCookie() {
    if (hasRequiredSetCookie) return setCookie.exports;
    hasRequiredSetCookie = 1;
    var defaultParseOptions = {
      decodeValues: true,
      map: false,
      silent: false
    };
    function isNonEmptyString(str) {
      return typeof str === "string" && !!str.trim();
    }
    function parseString(setCookieValue, options2) {
      var parts = setCookieValue.split(";").filter(isNonEmptyString);
      var nameValuePairStr = parts.shift();
      var parsed = parseNameValuePair(nameValuePairStr);
      var name = parsed.name;
      var value = parsed.value;
      options2 = options2 ? Object.assign({}, defaultParseOptions, options2) : defaultParseOptions;
      try {
        value = options2.decodeValues ? decodeURIComponent(value) : value;
      } catch (e) {
        console.error("set-cookie-parser encountered an error while decoding a cookie with value '" + value + "'. Set options.decodeValues to false to disable this feature.", e);
      }
      var cookie2 = {
        name,
        value
      };
      parts.forEach(function(part) {
        var sides = part.split("=");
        var key2 = sides.shift().trimLeft().toLowerCase();
        var value2 = sides.join("=");
        if (key2 === "expires") {
          cookie2.expires = new Date(value2);
        } else if (key2 === "max-age") {
          cookie2.maxAge = parseInt(value2, 10);
        } else if (key2 === "secure") {
          cookie2.secure = true;
        } else if (key2 === "httponly") {
          cookie2.httpOnly = true;
        } else if (key2 === "samesite") {
          cookie2.sameSite = value2;
        } else if (key2 === "partitioned") {
          cookie2.partitioned = true;
        } else {
          cookie2[key2] = value2;
        }
      });
      return cookie2;
    }
    function parseNameValuePair(nameValuePairStr) {
      var name = "";
      var value = "";
      var nameValueArr = nameValuePairStr.split("=");
      if (nameValueArr.length > 1) {
        name = nameValueArr.shift();
        value = nameValueArr.join("=");
      } else {
        value = nameValuePairStr;
      }
      return {
        name,
        value
      };
    }
    function parse(input, options2) {
      options2 = options2 ? Object.assign({}, defaultParseOptions, options2) : defaultParseOptions;
      if (!input) {
        if (!options2.map) {
          return [];
        } else {
          return {};
        }
      }
      if (input.headers) {
        if (typeof input.headers.getSetCookie === "function") {
          input = input.headers.getSetCookie();
        } else if (input.headers["set-cookie"]) {
          input = input.headers["set-cookie"];
        } else {
          var sch = input.headers[Object.keys(input.headers).find(function(key2) {
            return key2.toLowerCase() === "set-cookie";
          })];
          if (!sch && input.headers.cookie && !options2.silent) {
            console.warn("Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning.");
          }
          input = sch;
        }
      }
      if (!Array.isArray(input)) {
        input = [
          input
        ];
      }
      if (!options2.map) {
        return input.filter(isNonEmptyString).map(function(str) {
          return parseString(str, options2);
        });
      } else {
        var cookies = {};
        return input.filter(isNonEmptyString).reduce(function(cookies2, str) {
          var cookie2 = parseString(str, options2);
          cookies2[cookie2.name] = cookie2;
          return cookies2;
        }, cookies);
      }
    }
    function splitCookiesString(cookiesString) {
      if (Array.isArray(cookiesString)) {
        return cookiesString;
      }
      if (typeof cookiesString !== "string") {
        return [];
      }
      var cookiesStrings = [];
      var pos = 0;
      var start;
      var ch;
      var lastComma;
      var nextStart;
      var cookiesSeparatorFound;
      function skipWhitespace() {
        while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) {
          pos += 1;
        }
        return pos < cookiesString.length;
      }
      function notSpecialChar() {
        ch = cookiesString.charAt(pos);
        return ch !== "=" && ch !== ";" && ch !== ",";
      }
      while (pos < cookiesString.length) {
        start = pos;
        cookiesSeparatorFound = false;
        while (skipWhitespace()) {
          ch = cookiesString.charAt(pos);
          if (ch === ",") {
            lastComma = pos;
            pos += 1;
            skipWhitespace();
            nextStart = pos;
            while (pos < cookiesString.length && notSpecialChar()) {
              pos += 1;
            }
            if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
              cookiesSeparatorFound = true;
              pos = nextStart;
              cookiesStrings.push(cookiesString.substring(start, lastComma));
              start = pos;
            } else {
              pos = lastComma + 1;
            }
          } else {
            pos += 1;
          }
        }
        if (!cookiesSeparatorFound || pos >= cookiesString.length) {
          cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
        }
      }
      return cookiesStrings;
    }
    setCookie.exports = parse;
    setCookie.exports.parse = parse;
    setCookie.exports.parseString = parseString;
    setCookie.exports.splitCookiesString = splitCookiesString;
    return setCookie.exports;
  }
  var setCookieExports = requireSetCookie();
  function create_fetch({ event, options: options2, manifest, state, get_cookie_header, set_internal }) {
    const server_fetch = async (info, init2) => {
      const original_request = normalize_fetch_input(info, init2, event.url);
      let mode = (info instanceof Request ? info.mode : init2?.mode) ?? "cors";
      let credentials = (info instanceof Request ? info.credentials : init2?.credentials) ?? "same-origin";
      return options2.hooks.handleFetch({
        event,
        request: original_request,
        fetch: async (info2, init3) => {
          const request = normalize_fetch_input(info2, init3, event.url);
          const url = new URL(request.url);
          if (!request.headers.has("origin")) {
            request.headers.set("origin", event.url.origin);
          }
          if (info2 !== original_request) {
            mode = (info2 instanceof Request ? info2.mode : init3?.mode) ?? "cors";
            credentials = (info2 instanceof Request ? info2.credentials : init3?.credentials) ?? "same-origin";
          }
          if ((request.method === "GET" || request.method === "HEAD") && (mode === "no-cors" && url.origin !== event.url.origin || url.origin === event.url.origin)) {
            request.headers.delete("origin");
          }
          if (url.origin !== event.url.origin) {
            if (`.${url.hostname}`.endsWith(`.${event.url.hostname}`) && credentials !== "omit") {
              const cookie2 = get_cookie_header(url, request.headers.get("cookie"));
              if (cookie2) request.headers.set("cookie", cookie2);
            }
            return fetch(request);
          }
          const prefix = assets || base;
          const decoded = decodeURIComponent(url.pathname);
          const filename = (decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded).slice(1);
          const filename_html = `${filename}/index.html`;
          const is_asset = manifest.assets.has(filename) || filename in manifest._.server_assets;
          const is_asset_html = manifest.assets.has(filename_html) || filename_html in manifest._.server_assets;
          if (is_asset || is_asset_html) {
            const file = is_asset ? filename : filename_html;
            if (state.read) {
              const type = is_asset ? manifest.mimeTypes[filename.slice(filename.lastIndexOf("."))] : "text/html";
              return new Response(state.read(file), {
                headers: type ? {
                  "content-type": type
                } : {}
              });
            } else if (read_implementation && file in manifest._.server_assets) {
              const length = manifest._.server_assets[file];
              const type = manifest.mimeTypes[file.slice(file.lastIndexOf("."))];
              return new Response(read_implementation(file), {
                headers: {
                  "Content-Length": "" + length,
                  "Content-Type": type
                }
              });
            }
            return await fetch(request);
          }
          if (has_prerendered_path(manifest, base + decoded)) {
            return await fetch(request);
          }
          if (credentials !== "omit") {
            const cookie2 = get_cookie_header(url, request.headers.get("cookie"));
            if (cookie2) {
              request.headers.set("cookie", cookie2);
            }
            const authorization = event.request.headers.get("authorization");
            if (authorization && !request.headers.has("authorization")) {
              request.headers.set("authorization", authorization);
            }
          }
          if (!request.headers.has("accept")) {
            request.headers.set("accept", "*/*");
          }
          if (!request.headers.has("accept-language")) {
            request.headers.set("accept-language", event.request.headers.get("accept-language"));
          }
          const response = await respond(request, options2, manifest, {
            ...state,
            depth: state.depth + 1
          });
          const set_cookie = response.headers.get("set-cookie");
          if (set_cookie) {
            for (const str of setCookieExports.splitCookiesString(set_cookie)) {
              const { name, value, ...options3 } = setCookieExports.parseString(str, {
                decodeValues: false
              });
              const path = options3.path ?? (url.pathname.split("/").slice(0, -1).join("/") || "/");
              set_internal(name, value, {
                path,
                encode: (value2) => value2,
                ...options3
              });
            }
          }
          return response;
        }
      });
    };
    return (input, init2) => {
      const response = server_fetch(input, init2);
      response.catch(() => {
      });
      return response;
    };
  }
  function normalize_fetch_input(info, init2, url) {
    if (info instanceof Request) {
      return info;
    }
    return new Request(typeof info === "string" ? new URL(info, url) : info, init2);
  }
  let body;
  let etag;
  let headers;
  function get_public_env(request) {
    body ??= `export const env=${JSON.stringify(public_env)}`;
    etag ??= `W/${Date.now()}`;
    headers ??= new Headers({
      "content-type": "application/javascript; charset=utf-8",
      etag
    });
    if (request.headers.get("if-none-match") === etag) {
      return new Response(void 0, {
        status: 304,
        headers
      });
    }
    return new Response(body, {
      headers
    });
  }
  const default_transform = ({ html }) => html;
  const default_filter = () => false;
  const default_preload = ({ type }) => type === "js" || type === "css";
  const page_methods = /* @__PURE__ */ new Set([
    "GET",
    "HEAD",
    "POST"
  ]);
  const allowed_page_methods = /* @__PURE__ */ new Set([
    "GET",
    "HEAD",
    "OPTIONS"
  ]);
  async function respond(request, options2, manifest, state) {
    const url = new URL(request.url);
    if (options2.csrf_check_origin) {
      const forbidden = is_form_content_type(request) && (request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE") && request.headers.get("origin") !== url.origin;
      if (forbidden) {
        const csrf_error = new HttpError(403, `Cross-site ${request.method} form submissions are forbidden`);
        if (request.headers.get("accept") === "application/json") {
          return json(csrf_error.body, {
            status: csrf_error.status
          });
        }
        return text(csrf_error.body.message, {
          status: csrf_error.status
        });
      }
    }
    if (options2.hash_routing && url.pathname !== base + "/" && url.pathname !== "/[fallback]") {
      return text("Not found", {
        status: 404
      });
    }
    let invalidated_data_nodes;
    const is_route_resolution_request = has_resolution_suffix(url.pathname);
    const is_data_request = has_data_suffix(url.pathname);
    if (is_route_resolution_request) {
      url.pathname = strip_resolution_suffix(url.pathname);
    } else if (is_data_request) {
      url.pathname = strip_data_suffix(url.pathname) + (url.searchParams.get(TRAILING_SLASH_PARAM) === "1" ? "/" : "") || "/";
      url.searchParams.delete(TRAILING_SLASH_PARAM);
      invalidated_data_nodes = url.searchParams.get(INVALIDATED_PARAM)?.split("").map((node) => node === "1");
      url.searchParams.delete(INVALIDATED_PARAM);
    }
    const headers2 = {};
    const { cookies, new_cookies, get_cookie_header, set_internal, set_trailing_slash } = get_cookies(request, url);
    const event = {
      cookies,
      fetch: null,
      getClientAddress: state.getClientAddress || (() => {
        throw new Error(`${"@sveltejs/adapter-netlify"} does not specify getClientAddress. Please raise an issue`);
      }),
      locals: {},
      params: {},
      platform: state.platform,
      request,
      route: {
        id: null
      },
      setHeaders: (new_headers) => {
        for (const key2 in new_headers) {
          const lower = key2.toLowerCase();
          const value = new_headers[key2];
          if (lower === "set-cookie") {
            throw new Error("Use `event.cookies.set(name, value, options)` instead of `event.setHeaders` to set cookies");
          } else if (lower in headers2) {
            throw new Error(`"${key2}" header is already set`);
          } else {
            headers2[lower] = value;
            if (state.prerendering && lower === "cache-control") {
              state.prerendering.cache = value;
            }
          }
        }
      },
      url,
      isDataRequest: is_data_request,
      isSubRequest: state.depth > 0
    };
    event.fetch = create_fetch({
      event,
      options: options2,
      manifest,
      state,
      get_cookie_header,
      set_internal
    });
    if (state.emulator?.platform) {
      event.platform = await state.emulator.platform({
        config: {},
        prerender: !!state.prerendering?.fallback
      });
    }
    let resolved_path;
    try {
      resolved_path = await options2.hooks.reroute({
        url: new URL(url),
        fetch: event.fetch
      }) ?? url.pathname;
    } catch {
      return text("Internal Server Error", {
        status: 500
      });
    }
    try {
      resolved_path = decode_pathname(resolved_path);
    } catch {
      return text("Malformed URI", {
        status: 400
      });
    }
    if (resolved_path !== url.pathname && !state.prerendering?.fallback && has_prerendered_path(manifest, resolved_path)) {
      const url2 = new URL(request.url);
      url2.pathname = is_data_request ? add_data_suffix(resolved_path) : is_route_resolution_request ? add_resolution_suffix(resolved_path) : resolved_path;
      const response = await fetch(url2, request);
      const headers22 = new Headers(response.headers);
      if (headers22.has("content-encoding")) {
        headers22.delete("content-encoding");
        headers22.delete("content-length");
      }
      return new Response(response.body, {
        headers: headers22,
        status: response.status,
        statusText: response.statusText
      });
    }
    let route = null;
    if (base && !state.prerendering?.fallback) {
      if (!resolved_path.startsWith(base)) {
        return text("Not found", {
          status: 404
        });
      }
      resolved_path = resolved_path.slice(base.length) || "/";
    }
    if (is_route_resolution_request) {
      return resolve_route(resolved_path, new URL(request.url), manifest);
    }
    if (resolved_path === `/${app_dir}/env.js`) {
      return get_public_env(request);
    }
    if (resolved_path.startsWith(`/${app_dir}`)) {
      const headers22 = new Headers();
      headers22.set("cache-control", "public, max-age=0, must-revalidate");
      return text("Not found", {
        status: 404,
        headers: headers22
      });
    }
    if (!state.prerendering?.fallback) {
      const matchers = await manifest._.matchers();
      for (const candidate of manifest._.routes) {
        const match = candidate.pattern.exec(resolved_path);
        if (!match) continue;
        const matched = exec(match, candidate.params, matchers);
        if (matched) {
          route = candidate;
          event.route = {
            id: route.id
          };
          event.params = decode_params(matched);
          break;
        }
      }
    }
    let resolve_opts = {
      transformPageChunk: default_transform,
      filterSerializedResponseHeaders: default_filter,
      preload: default_preload
    };
    let trailing_slash = "never";
    try {
      const page_nodes = route?.page ? new PageNodes(await load_page_nodes(route.page, manifest)) : void 0;
      if (route) {
        if (url.pathname === base || url.pathname === base + "/") {
          trailing_slash = "always";
        } else if (page_nodes) {
          if (DEV) ;
          trailing_slash = page_nodes.trailing_slash();
        } else if (route.endpoint) {
          const node = await route.endpoint();
          trailing_slash = node.trailingSlash ?? "never";
          if (DEV) ;
        }
        if (!is_data_request) {
          const normalized = normalize_path(url.pathname, trailing_slash);
          if (normalized !== url.pathname && !state.prerendering?.fallback) {
            return new Response(void 0, {
              status: 308,
              headers: {
                "x-sveltekit-normalize": "1",
                location: (normalized.startsWith("//") ? url.origin + normalized : normalized) + (url.search === "?" ? "" : url.search)
              }
            });
          }
        }
        if (state.before_handle || state.emulator?.platform) {
          let config = {};
          let prerender = false;
          if (route.endpoint) {
            const node = await route.endpoint();
            config = node.config ?? config;
            prerender = node.prerender ?? prerender;
          } else if (page_nodes) {
            config = page_nodes.get_config() ?? config;
            prerender = page_nodes.prerender();
          }
          if (state.before_handle) {
            state.before_handle(event, config, prerender);
          }
          if (state.emulator?.platform) {
            event.platform = await state.emulator.platform({
              config,
              prerender
            });
          }
        }
      }
      set_trailing_slash(trailing_slash);
      if (state.prerendering && !state.prerendering.fallback) disable_search(url);
      const response = await with_event(event, () => options2.hooks.handle({
        event,
        resolve: (event2, opts) => with_event(null, () => resolve2(event2, page_nodes, opts).then((response2) => {
          for (const key2 in headers2) {
            const value = headers2[key2];
            response2.headers.set(key2, value);
          }
          add_cookies_to_headers(response2.headers, Object.values(new_cookies));
          if (state.prerendering && event2.route.id !== null) {
            response2.headers.set("x-sveltekit-routeid", encodeURI(event2.route.id));
          }
          return response2;
        }))
      }));
      if (response.status === 200 && response.headers.has("etag")) {
        let if_none_match_value = request.headers.get("if-none-match");
        if (if_none_match_value?.startsWith('W/"')) {
          if_none_match_value = if_none_match_value.substring(2);
        }
        const etag2 = response.headers.get("etag");
        if (if_none_match_value === etag2) {
          const headers22 = new Headers({
            etag: etag2
          });
          for (const key2 of [
            "cache-control",
            "content-location",
            "date",
            "expires",
            "vary",
            "set-cookie"
          ]) {
            const value = response.headers.get(key2);
            if (value) headers22.set(key2, value);
          }
          return new Response(void 0, {
            status: 304,
            headers: headers22
          });
        }
      }
      if (is_data_request && response.status >= 300 && response.status <= 308) {
        const location = response.headers.get("location");
        if (location) {
          return redirect_json_response(new Redirect(response.status, location));
        }
      }
      return response;
    } catch (e) {
      if (e instanceof Redirect) {
        const response = is_data_request ? redirect_json_response(e) : route?.page && is_action_json_request(event) ? action_json_redirect(e) : redirect_response(e.status, e.location);
        add_cookies_to_headers(response.headers, Object.values(new_cookies));
        return response;
      }
      return await handle_fatal_error(event, options2, e);
    }
    async function resolve2(event2, page_nodes, opts) {
      try {
        if (opts) {
          resolve_opts = {
            transformPageChunk: opts.transformPageChunk || default_transform,
            filterSerializedResponseHeaders: opts.filterSerializedResponseHeaders || default_filter,
            preload: opts.preload || default_preload
          };
        }
        if (options2.hash_routing || state.prerendering?.fallback) {
          return await render_response({
            event: event2,
            options: options2,
            manifest,
            state,
            page_config: {
              ssr: false,
              csr: true
            },
            status: 200,
            error: null,
            branch: [],
            fetched: [],
            resolve_opts
          });
        }
        if (route) {
          const method = event2.request.method;
          let response;
          if (is_data_request) {
            response = await render_data(event2, route, options2, manifest, state, invalidated_data_nodes, trailing_slash);
          } else if (route.endpoint && (!route.page || is_endpoint_request(event2))) {
            response = await render_endpoint(event2, await route.endpoint(), state);
          } else if (route.page) {
            if (!page_nodes) {
              throw new Error("page_nodes not found. This should never happen");
            } else if (page_methods.has(method)) {
              response = await render_page(event2, route.page, options2, manifest, state, page_nodes, resolve_opts);
            } else {
              const allowed_methods2 = new Set(allowed_page_methods);
              const node = await manifest._.nodes[route.page.leaf]();
              if (node?.server?.actions) {
                allowed_methods2.add("POST");
              }
              if (method === "OPTIONS") {
                response = new Response(null, {
                  status: 204,
                  headers: {
                    allow: Array.from(allowed_methods2.values()).join(", ")
                  }
                });
              } else {
                const mod = [
                  ...allowed_methods2
                ].reduce((acc, curr) => {
                  acc[curr] = true;
                  return acc;
                }, {});
                response = method_not_allowed(mod, method);
              }
            }
          } else {
            throw new Error("Route is neither page nor endpoint. This should never happen");
          }
          if (request.method === "GET" && route.page && route.endpoint) {
            const vary = response.headers.get("vary")?.split(",")?.map((v) => v.trim().toLowerCase());
            if (!(vary?.includes("accept") || vary?.includes("*"))) {
              response = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: new Headers(response.headers)
              });
              response.headers.append("Vary", "Accept");
            }
          }
          return response;
        }
        if (state.error && event2.isSubRequest) {
          const headers22 = new Headers(request.headers);
          headers22.set("x-sveltekit-error", "true");
          return await fetch(request, {
            headers: headers22
          });
        }
        if (state.error) {
          return text("Internal Server Error", {
            status: 500
          });
        }
        if (state.depth === 0) {
          return await respond_with_error({
            event: event2,
            options: options2,
            manifest,
            state,
            status: 404,
            error: new SvelteKitError(404, "Not Found", `Not found: ${event2.url.pathname}`),
            resolve_opts
          });
        }
        if (state.prerendering) {
          return text("not found", {
            status: 404
          });
        }
        return await fetch(request);
      } catch (e) {
        return await handle_fatal_error(event2, options2, e);
      } finally {
        event2.cookies.set = () => {
          throw new Error("Cannot use `cookies.set(...)` after the response has been generated");
        };
        event2.setHeaders = () => {
          throw new Error("Cannot use `setHeaders(...)` after the response has been generated");
        };
      }
    }
  }
  function load_page_nodes(page, manifest) {
    return Promise.all([
      ...page.layouts.map((n) => n == void 0 ? n : manifest._.nodes[n]()),
      manifest._.nodes[page.leaf]()
    ]);
  }
  function filter_private_env(env, { public_prefix, private_prefix }) {
    return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(private_prefix) && (public_prefix === "" || !k.startsWith(public_prefix))));
  }
  function filter_public_env(env, { public_prefix, private_prefix }) {
    return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(public_prefix) && (private_prefix === "" || !k.startsWith(private_prefix))));
  }
  const prerender_env_handler = {
    get({ type }, prop) {
      throw new Error(`Cannot read values from $env/dynamic/${type} while prerendering (attempted to read env.${prop.toString()}). Use $env/static/${type} instead`);
    }
  };
  let init_promise;
  Server = class {
    #options;
    #manifest;
    constructor(manifest) {
      this.#options = options;
      this.#manifest = manifest;
    }
    async init({ env, read }) {
      const prefixes = {
        public_prefix: this.#options.env_public_prefix,
        private_prefix: this.#options.env_private_prefix
      };
      const private_env = filter_private_env(env, prefixes);
      const public_env2 = filter_public_env(env, prefixes);
      set_private_env(prerendering ? new Proxy({
        type: "private"
      }, prerender_env_handler) : private_env);
      set_public_env(prerendering ? new Proxy({
        type: "public"
      }, prerender_env_handler) : public_env2);
      set_safe_public_env(public_env2);
      if (read) {
        set_read_implementation(read);
      }
      await (init_promise ??= (async () => {
        try {
          const module = await get_hooks();
          this.#options.hooks = {
            handle: module.handle || (({ event, resolve: resolve2 }) => resolve2(event)),
            handleError: module.handleError || (({ error }) => console.error(error)),
            handleFetch: module.handleFetch || (({ request, fetch: fetch2 }) => fetch2(request)),
            reroute: module.reroute || (() => {
            }),
            transport: module.transport || {}
          };
          if (module.init) {
            await module.init();
          }
        } catch (error) {
          {
            throw error;
          }
        }
      })());
    }
    async respond(request, options2) {
      return respond(request, this.#options, this.#manifest, {
        ...options2,
        error: false,
        depth: 0
      });
    }
  };
})();
export {
  Server,
  __tla
};
