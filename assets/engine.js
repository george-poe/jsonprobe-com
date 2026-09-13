/* JSON tools engine  —  pure functions, no DOM dependency.
 *
 * one file, loaded from two places: 
 *   · the page (<script src="/assets/engine.js">) —  small input handled synchronously
 *   · Web Worker (importScripts('engine.js')) —  large input never blocks the main thread
 *
 * hung on self.JSONEngine so both the browser and the worker context can use it.
 */
(function (root) {
  "use strict";

  /* ── Locating syntax errors ──────────────────────────────────────────────
   * ⚠️ never rely on the message JSON.parse throws.
   *
   * measured on Chrome/V8, 2026-09: the old message read "Unexpected token } in JSON at
   * position 137", but **newer engines no longer provide position**, they give a context snippet instead: 
   *     Unexpected token '}',..."b": }\n}" is not valid JSON
   * in other words, a modern engine will not tell you the line and column itself.
   *
   * so this ships its own recursive descent parser with one job: after JSON.parse throws,
   * scan it again, find the **first illegal offset** and convert it to line/column.
   * it only runs on the failure path, so a normal format never pays for a second parse.
   */

  function ParseError(msg, line, col, pos) {
    this.message = msg;
    this.line = line;
    this.col = col;
    this.pos = pos;
  }

  /* scan the text once and return a ParseError for the first syntax error; return null when there is none. */
  function scanForError(text) {
    var i = 0, n = text.length, line = 1, col = 1;

    function fail(msg) { throw new ParseError(msg, line, col, i); }
    function bump() {
      // charAt allocates a single-character string per call; this runs once per character over the whole file, 
      // 100 MB is 100 million allocations. switched to comparing charCodeAt numbers.
      if (text.charCodeAt(i) === 10) { line++; col = 1; } else { col++; }
      i++;
    }
    function isDigit(c) { return c >= 48 && c <= 57; }
    function ws() {
      while (i < n) {
        var c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) bump();
        else break;
      }
    }
    function peek() { return i < n? text.charAt(i): ""; }
    function matchWord(w) {
      // substr allocates a new string; the three known-length words are compared by charCodeAt instead
      if (i + w.length > n) return false;
      for (var k = 0; k < w.length; k++) {
        if (text.charCodeAt(i + k)!== w.charCodeAt(k)) return false;
      }
      return true;
    }

    function value() {
      ws();
      if (i >= n) fail("The document ends here, but a value is still missing");
      var c = peek();
      if (c === "{") return object();
      if (c === "[") return array();
      if (c === '"') return string();
      if (matchWord("true")) { i += 4; col += 4; return; }
      if (matchWord("false")) { i += 5; col += 5; return; }
      if (matchWord("null")) { i += 4; col += 4; return; }
      if (c === "-" || (c >= "0" && c <= "9")) return number();
      if (c === "'") fail("JSON has no single-quoted strings — keys and string values both need double quotes");
      if (matchWord("undefined")) fail("undefined is not a JSON value — use null for an absent value");
      if (matchWord("NaN")) fail("NaN is not a valid JSON value");
      if (matchWord("Infinity")) fail("Infinity is not a valid JSON value");
      if (c === "/") fail("JSON has no comments — // and /* */ are not in the spec; they belong to JSONC, which is what VS Code settings and tsconfig.json use");
      fail("The character " + JSON.stringify(c) + " cannot start a value (expected { [ \" a number, true, false or null)");
    }

    function string() {
      var sLine = line, sCol = col;
      bump();                                    // opening quote
      for (;;) {
        if (i >= n) {
          throw new ParseError(
            "Unterminated string — no closing double quote before the end of input", sLine, sCol, i);
        }
        var cc = text.charCodeAt(i);
        if (cc === 34) { bump(); return; }        // "
        if (cc === 92) {                          // \
          bump();
          var e = text.charAt(i);
          if (e === "u") {
            for (var k = 0; k < 4; k++) {
              bump();
              if (i < n &&!/[0-9a-fA-F]/.test(text.charAt(i))) {
                fail("\\u must be followed by four hex digits");
              }
            }
            bump();
          } else if ('"\\/bfnrt'.indexOf(e) >= 0) {
            bump();
          } else {
            fail("Unrecognised escape \\" + e);
          }
          continue;
        }
        if (cc < 0x20) {
          fail("A string cannot contain a raw control character (code point " + cc +
               ") — write a newline as \\n");
        }
        bump();
      }
    }

    function number() {
      if (peek() === "-") bump();
      if (peek() === "0") {
        bump();
        if (/[0-9]/.test(peek())) fail("A number cannot have a leading zero (01 is invalid)");
      } else if (/[1-9]/.test(peek())) {
        while (isDigit(text.charCodeAt(i))) bump();
      } else {
        fail("A minus sign must be followed by a digit");
      }
      if (peek() === ".") {
        bump();
        if (!/[0-9]/.test(peek())) fail("A decimal point must be followed by at least one digit");
        while (isDigit(text.charCodeAt(i))) bump();
      }
      if (peek() === "e" || peek() === "E") {
        bump();
        if (peek() === "+" || peek() === "-") bump();
        if (!/[0-9]/.test(peek())) fail("An exponent must be followed by at least one digit");
        while (isDigit(text.charCodeAt(i))) bump();
      }
    }

    function object() {
      bump();                                    // {
      ws();
      if (peek() === "}") { bump(); return; }
      for (;;) {
        ws();
        if (peek() === "}") fail("Extra comma — an object's last member cannot be followed by a comma");
        if (peek()!== '"') {
          if (peek() === "'") fail("Object keys must be double-quoted, not single-quoted");
          if (peek() === "/") fail("JSON has no comments — // and /* */ are not in the spec; they belong to JSONC, which is what VS Code settings and tsconfig.json use");
          if (peek() === "") fail("Unterminated object — no closing } before the end of input");
          fail("An object key must be a double-quoted string, but found " + JSON.stringify(peek()));
        }
        string();
        ws();
        if (peek()!== ":") {
          fail("Expected a colon after the key, but found " +
               (peek() === ""? "the end of the file": JSON.stringify(peek())));
        }
        bump();
        value();
        ws();
        var c = peek();
        if (c === ",") { bump(); continue; }
        if (c === "}") { bump(); return; }
        if (c === "") fail("Unterminated object — no closing } before the end of input");
        fail("Expected a comma or } inside an object, but found " + JSON.stringify(c));
      }
    }

    function array() {
      bump();                                    // [
      ws();
      if (peek() === "]") { bump(); return; }
      for (;;) {
        ws();
        if (peek() === "]") fail("Extra comma — an array's last element cannot be followed by a comma");
        value();
        ws();
        var c = peek();
        if (c === ",") { bump(); continue; }
        if (c === "]") { bump(); return; }
        if (c === "") fail("Unterminated array — no closing ] before the end of input");
        fail("Expected a comma or ] inside an array, but found " + JSON.stringify(c));
      }
    }

    try {
      value();
      ws();
      if (i < n) fail("Only one value may appear at the top level, but there is trailing content");
      return null;
    } catch (e) {
      if (e instanceof ParseError) return e;
      throw e;
    }
  }

  /* one place to build an error: use the position the scan found; only fall back to the engine message. */
  /* scan cost ceiling. measured: about 300 ms per 10 MB (inside the worker), about 3 s at 100 MB.
     waiting 3 s on the error path to buy an exact line/column beats giving no position; the ceiling stays 192 MB
     it only stops someone dumping a GB-scale file in and killing the tab. */
  var MAX_SCAN = 192 * 1024 * 1024;

  function locate(text, err) {
    if (text.length <= MAX_SCAN) {
      var scan = null;
      try { scan = scanForError(text); } catch (e) { scan = null; }
      if (scan) {
        return {
          line: scan.line,
          column: scan.col,
          pos: scan.pos,
          message: scan.message,
          excerpt: excerpt(text, scan.line, scan.col, 40, scan.pos)
        };
      }
    }
    var msg = (err && err.message) || String(err);
    var m = /at position (\d+)/.exec(msg);
    if (!m) {
      return { line: null, column: null, message: msg, excerpt: "" };
    }
    var pos = Math.min(parseInt(m[1], 10), text.length), ln = 1, cl = 1;
    for (var j = 0; j < pos; j++) {
      if (text.charCodeAt(j) === 10) { ln++; cl = 1; } else { cl++; }
    }
    return {
      line: ln, column: cl, pos: pos,
      message: msg.replace(/\s*in JSON at position \d+/, ""),
      excerpt: excerpt(text, ln, cl, 40, pos)
    };
  }

  /* ── raw text around the offending line, for the error preview ── */
  function excerpt(text, line, column, radius, pos) {
    if (line == null) return "";
    radius = radius || 40;
    var raw;
    if (pos!= null) {
      // a byte offset pins the line bounds directly, O(one line). splitting the whole file at 100 MB /
      // on 4.8 M lines that builds 4.8 M temporary strings, dearer than the scan itself.
      var ls = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
      var le = text.indexOf("\n", pos);
      if (le < 0) le = text.length;
      raw = text.slice(ls, le);
      column = pos - ls + 1;
    } else {
      raw = text.split("\n")[line - 1] || "";
    }
    var start = Math.max(0, column - 1 - radius);
    var end = Math.min(raw.length, column - 1 + radius);
    return (start > 0? "…": "") + raw.slice(start, end) + (end < raw.length? "…": "");
  }

  /* ── sort keys (recursive, array order left alone) ── */
  function sortKeysDeep(v) {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === "object") {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortKeysDeep(v[k]); });
      return out;
    }
    return v;
  }

  function indentOf(opt) {
    if (opt.indent === "tab") return "\t";
    if (opt.indent === "1") return " ";
    if (opt.indent === "3") return "   ";
    if (opt.indent === "4") return "    ";
    return "  ";                       // default 2 spaces — must match the UI default
  }

  /* ── Formatting ──────────────────────────────────────────────────
   * it also does two things jsonformatter.org does not: 
   *   1. report the output size and the shrink ratio
   *   2. report the top-level shape (object/array/scalar + entry count), which is what a developer wants first
   */
  function format(text, opt) {
    opt = opt || {};
    if (!text ||!text.trim()) {
      return { ok: false, error: { message: "The input is empty", line: null, column: null } };
    }
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      var loc = locate(text, e);
      loc.excerpt = excerpt(text, loc.line, loc.column);
      return { ok: false, error: loc };
    }
    if (opt.sortKeys) {
      try {
        data = sortKeysDeep(data);
      } catch (e) {
        return { ok: false, error: {
          message: "Sorting has to visit every level, and this document nests deeper than "
            + "that walk can go (" + e.name + "). Format it without sorting and it works.",
          line: null, column: null } };
      }
    }

    var out;
    try {
      out = opt.minify
? JSON.stringify(data)
: JSON.stringify(data, null, indentOf(opt));
    } catch (e) {
      return { ok: false, error: {
        message: "The browser refused to serialise this document (" + e.name +
          "). It parsed, so the nesting is at the edge of what a recursive walk survives.",
        line: null, column: null } };
    }

    // the stats walk recurses, so a few thousand levels hit the call stack. they are supplementary — they must not take a
    // successful format down with it: if the numbers cannot be computed, say why and return the output anyway.
    var stats = null, statsError = null;
    try {
      stats = {
        bytesIn: byteLen(text),
        bytesOut: byteLen(out),
        linesOut: countLines(out),
        nodes: countNodes(data),
        depth: maxDepth(data),
        rootType: Array.isArray(data)? "array": (data === null? "null": typeof data),
        rootSize: (data && typeof data === "object")
? (Array.isArray(data)? data.length: Object.keys(data).length)
: null
      };
    } catch (e) {
      statsError = e.name;
    }

    return { ok: true, output: out, stats: stats, statsUnavailable: statsError };
  }

  function byteLen(s) {
    // TextEncoder is truer than s.length; fall back when it is missing.
    // but past 16 MB it stops allocating the same-size Uint8Array: on a 100 MB output
    // this step measures dearer than the entire parse, and formatted output is nearly all ASCII, so the error is negligible.
    if (s.length > 16777216) return s.length;
    if (typeof TextEncoder!== "undefined") return new TextEncoder().encode(s).length;
    return s.length;
  }

  function countLines(s) {
    // on a big string split("\n") builds tens of millions of temporary strings, so 100 MB of input measures slower than
    // the whole parse. small inputs keep the old split path.
    if (s.length < 2097152) return s.split("\n").length;
    var n = 1, i = -1;
    while ((i = s.indexOf("\n", i + 1))!== -1) n++;
    return n;
  }

  function countNodes(v) {
    if (v === null || typeof v!== "object") return 1;
    var n = 1, k;
    if (Array.isArray(v)) { for (k = 0; k < v.length; k++) n += countNodes(v[k]); }
    else { for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) n += countNodes(v[k]); }
    return n;
  }

  function maxDepth(v) {
    if (v === null || typeof v!== "object") return 0;
    var best = 0, k;
    if (Array.isArray(v)) { for (k = 0; k < v.length; k++) best = Math.max(best, maxDepth(v[k])); }
    else { for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) best = Math.max(best, maxDepth(v[k])); }
    return best + 1;
  }

  /* ── JSONPath subset query ────────────────────────────────────────
   * supports: $.a.b, $[0], $[*], $..key (recursive descent), $['k'], $.a[*].b
   * this is the part developers actually use, not full JSONPath.
   */
  function tokenizePath(path) {
    var s = path.trim();
    if (s === "$" || s === "") return [];
    s = s.replace(/^\$/, "");
    var toks = [], re = /\.\.([A-Za-z_$][\w$]*)|\.([A-Za-z_$][\w$]*)|\[(\*|\d+)\]/g, m, last = 0;
    while ((m = re.exec(s))!== null) {
      if (m.index!== last) throw new Error("The JSONPath broke at offset " + last + ": " + s.slice(last, m.index + 1));
      last = re.lastIndex;
      if (m[1]!== undefined) toks.push({ t: "desc", k: m[1] });
      else if (m[2]!== undefined) toks.push({ t: "key", k: m[2] });
      else if (m[3] === "*") toks.push({ t: "wild" });
      else toks.push({ t: "idx", i: parseInt(m[3], 10) });
    }
    if (last!== s.length) throw new Error("The JSONPath cannot be parsed from " + s.slice(last));
    return toks;
  }

  function descend(v, key, acc) {
    if (v === null || typeof v!== "object") return;
    if (Array.isArray(v)) { v.forEach(function (x) { descend(x, key, acc); }); return; }
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (k === key) acc.push(v[k]);
      descend(v[k], key, acc);
    }
  }

  function query(text, path) {
    if (!text ||!text.trim()) return { ok: false, error: "The input is empty" };
    if (!path ||!path.trim()) return { ok: false, error: "The expression is empty" };
    var data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: "Input is not valid JSON: " + e.message }; }

    var toks;
    try { toks = tokenizePath(path); } catch (e) { return { ok: false, error: e.message }; }

    var cur = [data];
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i], next = [];
      for (var j = 0; j < cur.length; j++) {
        var v = cur[j];
        if (tk.t === "desc") {
          descend(v, tk.k, next);
        } else if (tk.t === "key") {
          if (v && typeof v === "object" &&!Array.isArray(v) &&
              Object.prototype.hasOwnProperty.call(v, tk.k)) next.push(v[tk.k]);
        } else if (tk.t === "idx") {
          if (Array.isArray(v) && v.length > tk.i) next.push(v[tk.i]);
        } else if (tk.t === "wild") {
          if (Array.isArray(v)) next.push.apply(next, v);
          else if (v && typeof v === "object") {
            Object.keys(v).forEach(function (k) { next.push(v[k]); });
          }
        }
      }
      cur = next;
    }
    return { ok: true, matches: cur, output: JSON.stringify(cur.length === 1? cur[0]: cur, null, 2) };
  }

  /* ── Structural diff ──────────────────────────────────────────────
   * reports real structural differences only, never a text line diff — a text diff is useless on JSON, 
   * because one added field makes every later line "change".
   */
  function diff(a, b, at, out) {
    at = at || "$"; out = out || [];
    if (a === b) return out;
    var ta = kind(a), tb = kind(b);
    if (ta!== tb) { out.push({ path: at, type: "changed", from: short(a), to: short(b) }); return out; }
    if (ta === "object") {
      var ka = Object.keys(a), kb = Object.keys(b), seen = {};
      ka.forEach(function (k) {
        seen[k] = 1;
        if (!Object.prototype.hasOwnProperty.call(b, k)) out.push({ path: at + "." + k, type: "removed", from: short(a[k]) });
        else diff(a[k], b[k], at + "." + k, out);
      });
      kb.forEach(function (k) {
        if (!seen[k]) out.push({ path: at + "." + k, type: "added", to: short(b[k]) });
      });
    } else if (ta === "array") {
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) {
        if (i >= a.length) out.push({ path: at + "[" + i + "]", type: "added", to: short(b[i]) });
        else if (i >= b.length) out.push({ path: at + "[" + i + "]", type: "removed", from: short(a[i]) });
        else diff(a[i], b[i], at + "[" + i + "]", out);
      }
    } else {
      out.push({ path: at, type: "changed", from: short(a), to: short(b) });
    }
    return out;
  }

  function kind(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
  }

  function short(v) {
    var s = v === undefined? "undefined": JSON.stringify(v);
    if (s === undefined) s = String(v);
    return s.length > 60? s.slice(0, 57) + "…": s;
  }

  /* ── JSON Schema validation (draft-07 subset) ────────────────────────
   * covers: type, required, properties, items, enum, const, 
   *       minimum/maximum, minLength/maxLength, pattern, 
   *       minItems/maxItems, uniqueItems, additionalProperties
   * does not cover: $ref, allOf/anyOf/oneOf, format (those are left for later)
   */
  function validateSchema(data, schema, at) {
    at = at || "$";
    var errs = [];
    if (schema === true || schema === undefined) return errs;
    if (schema === false) { errs.push({ path: at, message: "The schema is false, which permits no value" }); return errs; }

    if (schema.type!== undefined) {
      var want = Array.isArray(schema.type)? schema.type: [schema.type];
      var got = kind(data);
      var ok = want.some(function (w) {
        if (w === "integer") return got === "number" && Number.isInteger(data);
        if (w === "number") return got === "number";
        return w === got;
      });
      if (!ok) {
        errs.push({ path: at, message: "Expected type " + want.join("/") + " but found " + got });
        return errs;                       // wrong type: no point checking deeper
      }
    }
    if (schema.enum && schema.enum.every(function (e) { return JSON.stringify(e)!== JSON.stringify(data); })) {
      errs.push({ path: at, message: "Value is not one of the enum values: " + short(data) });
    }
    if (schema.const!== undefined && JSON.stringify(schema.const)!== JSON.stringify(data)) {
      errs.push({ path: at, message: "Expected the constant value " + short(schema.const) + " but got " + short(data) });
    }

    if (kind(data) === "string") {
      if (schema.minLength!= null && data.length < schema.minLength) {
        errs.push({ path: at, message: "The string length is " + data.length + " is shorter than minLength " + schema.minLength });
      }
      if (schema.maxLength!= null && data.length > schema.maxLength) {
        errs.push({ path: at, message: "The string length is " + data.length + " is longer than maxLength " + schema.maxLength });
      }
      if (schema.pattern) {
        var re;
        try { re = new RegExp(schema.pattern); }
        catch (e) { errs.push({ path: at, message: "The pattern in the schema is not a valid regular expression: " + schema.pattern }); re = null; }
        if (re &&!re.test(data)) errs.push({ path: at, message: "Does not match pattern " + schema.pattern });
      }
    }

    if (kind(data) === "number") {
      if (schema.minimum!= null && data < schema.minimum) errs.push({ path: at, message: data + " is below minimum " + schema.minimum });
      if (schema.maximum!= null && data > schema.maximum) errs.push({ path: at, message: data + " exceeds maximum " + schema.maximum });
      if (schema.exclusiveMinimum!= null && data <= schema.exclusiveMinimum) errs.push({ path: at, message: data + " is not above exclusiveMinimum " + schema.exclusiveMinimum });
      if (schema.exclusiveMaximum!= null && data >= schema.exclusiveMaximum) errs.push({ path: at, message: data + " is not below exclusiveMaximum " + schema.exclusiveMaximum });
    }

    if (kind(data) === "object") {
      (schema.required || []).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) {
          errs.push({ path: at, message: "Required property missing: \"" + k + "\"" });
        }
      });
      var props = schema.properties || {};
      Object.keys(data).forEach(function (k) {
        if (props[k]!== undefined) {
          errs.push.apply(errs, validateSchema(data[k], props[k], at + "." + k));
        } else if (schema.additionalProperties === false) {
          errs.push({ path: at + "." + k, message: "Additional properties are not allowed here" });
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          errs.push.apply(errs, validateSchema(data[k], schema.additionalProperties, at + "." + k));
        }
      });
    }

    if (kind(data) === "array") {
      if (schema.minItems!= null && data.length < schema.minItems) errs.push({ path: at, message: "The array has " + data.length + " items, fewer than minItems " + schema.minItems });
      if (schema.maxItems!= null && data.length > schema.maxItems) errs.push({ path: at, message: "The array has " + data.length + " items, more than maxItems " + schema.maxItems });
      if (schema.uniqueItems) {
        var seen = {};
        data.forEach(function (x, i) {
          var key = JSON.stringify(x);
          if (seen[key]!== undefined) errs.push({ path: at + "[" + i + "]", message: "Duplicate of item " + seen[key] + "" });
          else seen[key] = i;
        });
      }
      if (schema.items) {
        data.forEach(function (x, i) {
          errs.push.apply(errs, validateSchema(x, schema.items, at + "[" + i + "]"));
        });
      }
    }
    return errs;
  }

  root.JSONEngine = {
    format: format,
    query: query,
    diff: diff,
    validateSchema: validateSchema,
    locate: locate,
    byteLen: byteLen
  };
})(typeof self!== "undefined"? self: this);
