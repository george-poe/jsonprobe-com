/* JSON 工具引擎  —  纯函数, 无 DOM 依赖.
 *
 * 同一份文件被两处加载: 
 *   · 页面(<script src="/assets/engine.js">) —  小输入同步处理
 *   · Web Worker(importScripts('engine.js')) —  大输入不阻塞主线程
 *
 * 挂在 self.JSONEngine 上, 这样浏览器和 worker 两种上下文都能用.
 */
(function (root) {
  "use strict";

  /* ── 语法错误定位 ──────────────────────────────────────────────
   * ⚠️ 不能依赖 JSON.parse 的报错消息.
   *
   * 实测(Chrome/V8, 2026-09): 旧版消息形如 "Unexpected token } in JSON at
   * position 137", 但**新版已经不再提供 position**, 改成给一段上下文: 
   *     Unexpected token '}',..."b": }\n}" is not valid JSON
   * 也就是说, 现代引擎自己不肯告诉你错在第几行第几列.
   *
   * 所以这里自带一个递归下降解析器, 只干一件事: 在 JSON.parse 报错之后
   * 重新扫一遍, 找出**第一个非法位置**并换算成行列.
   * 它只在失败路径上跑, 正常格式化不会多付一次解析成本.
   */

  function ParseError(msg, line, col, pos) {
    this.message = msg;
    this.line = line;
    this.col = col;
    this.pos = pos;
  }

  /* 扫一遍文本, 返回第一个语法错误的 ParseError; 没问题返回 null. */
  function scanForError(text) {
    var i = 0, n = text.length, line = 1, col = 1;

    function fail(msg) { throw new ParseError(msg, line, col, i); }
    function bump() {
      // charAt 每次要分配一个单字串; 这个函数全文每字符调一次, 
      // 100 MB 就是 1 亿次分配.改成 charCodeAt 比数字比较.
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
      // substr 会分配新串; 先用长度已知的三个词走 charCodeAt 比较
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

  /* 统一的报错构造: 先用自己扫出来的位置; 拿不到再退化到引擎消息. */
  /* 扫描代价上限.实测每 10 MB 约 300 ms(在 worker 里), 100 MB 约 3 秒.
     报错路径上等 3 秒换一个精确行列, 比不给位置强; 上限留到 192 MB
     只是防止有人丢个 GB 级文件进来把标签页打挂. */
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

  /* ── 输出那一行附近的原文, 用于错误预览 ── */
  function excerpt(text, line, column, radius, pos) {
    if (line == null) return "";
    radius = radius || 40;
    var raw;
    if (pos!= null) {
      // 有字节偏移就直接钉行边界, O(一行).split 整个文件在 100 MB /
      // 480 万行上会造出 480 万个临时串, 比扫描本身还贵.
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

  /* ── 排序键(递归, 数组顺序保持不动) ── */
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

  /* ── 格式化 ──────────────────────────────────────────────────
   * 顺带做两件 jsonformatter.org 不做的事: 
   *   1. 报告输出体积与压缩率
   *   2. 报告顶层结构(对象/数组/标量 + 条目数), 这是开发者真正想先知道的
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

    // 统计用的是递归，几千层就会撞上调用栈。它是附加信息，不该把
    // 已经成功的格式化一起拖死：算不出来就给个原因，输出照常返回。
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
    // TextEncoder 比 s.length 准; 没有就退化.
    // 但超过 16 MB 时不再分配那个同尺寸的 Uint8Array: 100 MB 的输出上
    // 这一步实测比整个解析还贵, 而格式化输出几乎全是 ASCII, 误差可忽略.
    if (s.length > 16777216) return s.length;
    if (typeof TextEncoder!== "undefined") return new TextEncoder().encode(s).length;
    return s.length;
  }

  function countLines(s) {
    // 大字符串上 split("\n") 会造出上千万个临时串, 100 MB 输入实测比
    // 整个解析还慢.小输入照旧.
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

  /* ── JSONPath 子集查询 ────────────────────────────────────────
   * 支持: $.a.b, $[0], $[*], $..key(递归下降), $['k'], $.a[*].b
   * 这是开发者最常用的那部分, 不是完整 JSONPath.
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

  /* ── 结构化 diff ──────────────────────────────────────────────
   * 只报真实的结构差异, 不做文本行 diff — 文本 diff 对 JSON 没用, 
   * 因为加一个字段会让后面所有行都"变化".
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

  /* ── JSON Schema 校验(draft-07 子集) ────────────────────────
   * 覆盖: type, required, properties, items, enum, const, 
   *       minimum/maximum, minLength/maxLength, pattern, 
   *       minItems/maxItems, uniqueItems, additionalProperties
   * 不覆盖: $ref, allOf/anyOf/oneOf, format(这几个留待后续)
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
