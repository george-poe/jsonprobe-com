/* JSON 工具前端.
 *
 * 所有重活走 Web Worker(见 worker.js); Worker 起不来就退化为同步调用, 
 * 不能让整个工具因为一个 worker 加载失败而不可用.
 */
(function () {
  "use strict";

  var E = window.JSONEngine;
  var $ = function (id) { return document.getElementById(id); };

  /* ── Worker 封装 ─────────────────────────────────────────────── */
  var Worker_ = { ready: false, w: null, seq: 0, pending: {} };

  try {
    Worker_.w = new Worker("/assets/worker.js");
    Worker_.w.onmessage = function (ev) {
      var cb = Worker_.pending[ev.data.id];
      if (cb) { delete Worker_.pending[ev.data.id]; cb(ev.data.result); }
    };
    Worker_.w.onerror = function () { Worker_.ready = false; };
    Worker_.ready = true;
  } catch (e) {
    Worker_.ready = false;
  }

  /* run() 统一入口: 优先 worker, 失败退化同步 */
  function run(op, payload, cb) {
    if (Worker_.ready) {
      var id = ++Worker_.seq;
      Worker_.pending[id] = cb;
      Worker_.w.postMessage(Object.assign({ id: id, op: op }, payload));
      return;
    }
    var r;
    if (op === "format") r = E.format(payload.text, payload.opt);
    else if (op === "query") r = E.query(payload.text, payload.path);
    else if (op === "diff") {
      var a, b;
      try { a = JSON.parse(payload.a); } catch (e) { return cb({ ok: false, error: { message: "Left side is not valid JSON: " + e.message } }); }
      try { b = JSON.parse(payload.b); } catch (e) { return cb({ ok: false, error: { message: "Right side is not valid JSON: " + e.message } }); }
      r = { ok: true, changes: E.diff(a, b) };
    }
    setTimeout(function () { cb(r); }, 0);
  }

  /* ── 小工具 ─────────────────────────────────────────────────── */
  function bytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function flash(el, msg) {
    var t = document.createElement("span");
    t.className = "flash";
    t.textContent = msg;
    el.appendChild(t);
    setTimeout(function () { t.remove(); }, 1400);
  }
  function now() { return (performance && performance.now)? performance.now(): Date.now(); }

  /* ── 选项 ───────────────────────────────────────────────────── */
  function opt() {
    return {
      indent: ($("opt-indent") || {}).value || "2",
      sortKeys:!!(($("opt-sort") || {}).checked),
      minify:!!(($("opt-minify") || {}).checked)
    };
  }

  /* ── 标签切换 ───────────────────────────────────────────────── */
  var TABS = ["format", "tree", "query", "diff", "schema"];
  function showTab(name) {
    TABS.forEach(function (t) {
      var p = $("panel-" + t), b = $("tab-" + t);
      if (p) p.hidden = (t!== name);
      if (b) b.setAttribute("aria-selected", t === name? "true": "false");
    });
    if (location.hash.slice(1)!== name) history.replaceState(null, "", "#" + name);
  }
  TABS.forEach(function (t) {
    var b = $("tab-" + t);
    if (b) b.addEventListener("click", function () { showTab(t); });
  });
  var initial = (location.hash || "").slice(1);
  if (TABS.indexOf(initial) < 0) initial = window.JSON_TOOLS_DEFAULT_TAB || "format";
  if (TABS.indexOf(initial) < 0) initial = "format";
  showTab(initial);

  /* ── 输入区 ─────────────────────────────────────────────────── */
  var input = $("input");
  var inputInfo = $("input-info");

  function updateInputInfo() {
    var n = E.byteLen(input.value);
    inputInfo.textContent = n? bytes(n) + " · " + input.value.split("\n").length + " lines": "empty";
  }
  input.addEventListener("input", updateInputInfo);
  updateInputInfo();

  /* 拖放.json 文件  —  纯浏览器 FileReader, 不上传任何服务器 */
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  if ($("file")) {
    $("file").addEventListener("change", function (e) {
      if (e.target.files[0]) readFile(e.target.files[0]);
    });
  }
  function readFile(f) {
    var t0 = now();
    var fr = new FileReader();
    fr.onload = function () {
      input.value = fr.result;
      updateInputInfo();
      flash(inputInfo, "Loaded " + f.name + " (" + bytes(E.byteLen(fr.result)) + ", " +
        Math.round(now() - t0) + " ms, all local)");
      doFormat();
    };
    fr.readAsText(f);
  }

  /* ── 格式化 / 校验 ──────────────────────────────────────────── */
  var out = $("output"), errBox = $("error"), stats = $("stats");

  function showError(err) {
    if (!err) { errBox.hidden = true; errBox.innerHTML = ""; return; }
    var pos = (err.line!= null)? ("line " + err.line + ", column " + err.column + ""): "position unknown";
    errBox.hidden = false;
    errBox.innerHTML =
      '<strong>Invalid JSON</strong> — ' + esc(pos) +
      '<div class="err-msg">' + esc(err.message || "") + "</div>" +
      (err.excerpt? '<pre class="err-ex">' + esc(err.excerpt) + "</pre>": "");
  }

  function showStats(s) {
    if (!s) { stats.hidden = true; return; }
    var saved = s.bytesIn? Math.round((1 - s.bytesOut / s.bytesIn) * 100): 0;
    var bits = [
      "Root <b>" + esc(s.rootType) + "</b>" + (s.rootSize!= null? " (" + s.rootSize + " entries)": ""),
      "Nesting depth <b>" + s.depth + "</b>",
      "Nodes <b>" + s.nodes.toLocaleString() + "</b>",
      "Output <b>" + bytes(s.bytesOut) + "</b> / " + s.linesOut.toLocaleString() + " lines",
      "Input <b>" + bytes(s.bytesIn) + "</b>"
    ];
    if (s.bytesOut < s.bytesIn) bits.push("Smaller than the input by <b>" + saved + "%</b>");
    stats.hidden = false;
    stats.innerHTML = bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
  }

  function doFormat() {
    if (!input.value.trim()) { out.textContent = ""; lastOutput = null; showError(null); showStats(null); return; }
    var t0 = now();
    $("btn-format").disabled = true;
    run("format", { text: input.value, opt: opt() }, function (r) {
      $("btn-format").disabled = false;
      var ms = (now() - t0).toFixed(0) + " ms" + (Worker_.ready? "": " (no worker available — ran on the main thread)");
      if (!r.ok) {
        out.textContent = "";
        lastOutput = null;
        showStats(null);
        showError(r.error);
      } else {
        showError(null);
        renderOutput(r.output);
        showStats(r.stats);
        if (r.statsUnavailable) {
          // 统计算不出来得说为什么，不然看起来像输出被吃掉了。
          $("stats").insertAdjacentHTML("beforeend",
            "<span>Nesting is too deep for the stats walk (" + esc(r.statsUnavailable) +
            ") — the formatted output above is complete.</span>");
        }
        $("stats").insertAdjacentHTML("beforeend", "<span>Took <b>" + ms + "</b></span>");
      }
    });
  }

  /* 大输出不全量塞进 DOM — 超过 1 MB 只渲染前 200 KB 并明确提示。
     但完整结果得留在 lastOutput 里：DOM 只是预览，Copy / Download 不能把
     被砍断的预览当结果交出去（那会交到一份不合法的 JSON）。 */
  var lastOutput = null;

  function renderOutput(s) {
    lastOutput = s;
    var old = $("trunc");
    if (old) old.remove();
    if (E.byteLen(s) > 1024 * 1024) {
      out.textContent = s.slice(0, 200 * 1024);
      out.insertAdjacentHTML("afterend",
        '<p class="note" id="trunc">This preview shows the first 200 KB — the page will not ' +
        'paint a whole 100 MB document. Copy and Download give the complete result.</p>');
    } else {
      out.textContent = s;
    }
  }

  function resultText() {
    return lastOutput == null ? out.textContent : lastOutput;
  }

  if ($("btn-format")) $("btn-format").addEventListener("click", doFormat);
  if ($("btn-clear")) $("btn-clear").addEventListener("click", function () {
    input.value = ""; out.textContent = ""; lastOutput = null; updateInputInfo(); showError(null); showStats(null);
  });
  if ($("btn-sample")) $("btn-sample").addEventListener("click", function () {
    input.value = JSON.stringify({
      user: { id: 4821, name: "Ada Lovelace", active: true, roles: ["admin", "dev"] },
      orders: [{ id: "A-1", total: 19.99, items: 2 }, { id: "A-2", total: 4.5, items: 1 }],
      meta: { page: 1, perPage: 20, total: 2 }
    });
    updateInputInfo(); doFormat();
  });
  if ($("btn-copy")) $("btn-copy").addEventListener("click", function () {
    navigator.clipboard.writeText(resultText()).then(function () {
      flash($("btn-copy"), "Copied");
    }, function () { flash($("btn-copy"), "Copy failed"); });
  });
  if ($("btn-download")) $("btn-download").addEventListener("click", function () {
    var blob = new Blob([resultText()], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = opt().minify? "minified.json": "formatted.json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doFormat(); }
  });
  ["opt-indent", "opt-sort", "opt-minify"].forEach(function (id) {
    if ($(id)) $(id).addEventListener("change", doFormat);
  });

  /* ── 树视图 ─────────────────────────────────────────────────── */
  var TREE_NODE_CAP = 5000;
  var treeTruncated = false;

  function buildTree(data) {
    var count = 0;
    treeTruncated = false;
    function node(v, key, suffix) {
      if (count++ > TREE_NODE_CAP) { treeTruncated = true; return null; }
      var k = kindOf(v);
      if (k!== "object" && k!== "array") {
        return el("div", "tn-leaf", null,
          key!= null? keyTag(key, suffix): null,
          el("span", "tn-val tn-" + k, JSON.stringify(v)));
      }
      var isArr = k === "array";
      var kids = isArr? v.map(function (x, i) { return [i, x]; })
: Object.keys(v).map(function (kk) { return [kk, v[kk]]; });
      var box = el("div", "tn-kids");
      var head = el("span", "tn-head", null,
        key!= null? keyTag(key, suffix): null,
        el("span", "tn-brace", isArr? "[": "{"),
        el("span", "tn-meta", kids.length + (isArr? " items": " keys")),
        el("span", "tn-brace", isArr? "]": "}"));
      var open = true;
      head.addEventListener("click", function () {
        open =!open;
        box.hidden =!open;
        head.classList.toggle("collapsed",!open);
      });
      var wrap = el("div", "tn-branch");
      wrap.appendChild(head);
      kids.forEach(function (kv) {
        var c = node(kv[1], String(kv[0]), isArr? "idx": "key");
        if (c) box.appendChild(c);
      });
      wrap.appendChild(box);
      return wrap;
    }
    return node(data, null, null);
  }

  function kindOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
  }
  function keyTag(k, suffix) {
    return el("span", "tn-key tn-key-" + suffix, (suffix === "idx"? k: '"' + k + '"'));
  }
  function el(tag, cls, text, c1, c2, c3) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text!= null) e.textContent = text;
    [c1, c2, c3].forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  var treeBox = $("tree");
  function doTree() {
    if (!treeBox) return;
    if (!input.value.trim()) { treeBox.innerHTML = '<p class="note">Paste some JSON in the box above first.</p>'; return; }
    var data;
    try { data = JSON.parse(input.value); }
    catch (e) {
      var loc = E.locate(input.value, e);
      treeBox.innerHTML = '<p class="note">Invalid JSON' +
        (loc.line!= null? " (line " + loc.line + ", column " + loc.column + ")": "") + ": " + esc(loc.message) + "</p>";
      return;
    }
    treeBox.innerHTML = "";
    var t = buildTree(data);
    if (t) treeBox.appendChild(t);
    // 截断必须说：默不作声地少画一半，比不截断还坑。
    if (treeTruncated) {
      treeBox.appendChild(el("p", "note",
        "The tree stopped at " + TREE_NODE_CAP.toLocaleString() +
        " nodes. The rest of the document is still there — it is just not drawn."
        + " Use the text view, or Download, for the whole thing."));
    }
  }
  if ($("tab-tree")) $("tab-tree").addEventListener("click", doTree);

  /* ── JSONPath 查询 ──────────────────────────────────────────── */
  if ($("btn-query")) $("btn-query").addEventListener("click", function () {
    var q = $("path").value;
    var res = $("query-result");
    run("query", { text: input.value, path: q }, function (r) {
      if (!r.ok) { res.className = "outbox err"; res.textContent = String(r.error); return; }
      res.className = "outbox";
      if (r.matches.length === 0) { res.textContent = "No matches."; return; }
      res.textContent = r.matches.length === 1
? JSON.stringify(r.matches[0], null, 2)
: "Matched " + r.matches.length + " matches:\\n\\n" + r.output;
    });
  });
  document.querySelectorAll("[data-path]").forEach(function (b) {
    b.addEventListener("click", function () {
      $("path").value = b.getAttribute("data-path");
      $("btn-query").click();
    });
  });

  /* ── Diff ───────────────────────────────────────────────────── */
  if ($("btn-diff")) $("btn-diff").addEventListener("click", function () {
    var box = $("diff-result");
    run("diff", { a: $("diff-a").value, b: $("diff-b").value }, function (r) {
      if (!r.ok) { box.className = "outbox err"; box.textContent = String(r.error); return; }
      box.className = "outbox";
      if (r.changes.length === 0) { box.textContent = "The two documents are structurally identical."; return; }
      var counts = { added: 0, removed: 0, changed: 0 };
      r.changes.forEach(function (c) { counts[c.type]++; });
      var head = "" + r.changes.length + " differences: " + counts.added +
        " added, " + counts.removed + " removed, " + counts.changed + " changed\n\n";
      box.textContent = head + r.changes.map(function (c) {
        if (c.type === "added") return "+ " + c.path + " = " + c.to;
        if (c.type === "removed") return "- " + c.path + " (was " + c.from + ")";
        return "~ " + c.path + ": " + c.from + " → " + c.to;
      }).join("\n");
    });
  });

  /* ── Schema 校验 ────────────────────────────────────────────── */
  if ($("btn-schema")) $("btn-schema").addEventListener("click", function () {
    var box = $("schema-result");
    var src = $("schema-src").value;
    if (!src.trim()) { box.className = "outbox err"; box.textContent = "Put a JSON Schema in the box above first."; return; }

    if (/^\s*https?:\/\//i.test(src)) { fetchSchema(src, box); return; }
    validateWith(src, box);
  });

  function validateWith(schemaText, box) {
    var schema;
    try { schema = JSON.parse(schemaText); }
    catch (e) { box.className = "outbox err"; box.textContent = "The schema itself is not valid JSON: " + e.message; return; }
    var data;
    try { data = JSON.parse(input.value); }
    catch (e) { box.className = "outbox err"; box.textContent = "The input is not valid JSON, so it cannot be validated."; return; }
    var errs = E.validateSchema(data, schema);
    if (errs.length === 0) {
      box.className = "outbox ok";
      box.textContent = "Passed. The data matches the schema (" + Object.keys(schema.properties || {}).length + " declared fields checked).";
      return;
    }
    box.className = "outbox err";
    box.textContent = "Found " + errs.length + " problems:\\n\\n" +
      errs.map(function (e) { return "· " + e.path + "  —  " + e.message; }).join("\n");
  }

  function fetchSchema(url, box) {
    box.className = "outbox";
    box.textContent = "Fetching " + url + " …";
    var tries = 0, MAX = 3;
    (function attempt() {
      tries++;
      fetch(url, { mode: "cors" })
.then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
.then(function (t) { validateWith(t, box); })
.catch(function (e) {
          // 网络失败自己重试, 最多 3 次
          if (tries < MAX) { box.textContent = "Attempt " + tries + " failed (" + e.message + "), retrying…"; setTimeout(attempt, 800 * tries); }
          else {
            box.className = "outbox err";
            box.textContent = "Could not fetch the schema (" + MAX + " tries, " + e.message + ").\n" +
              "Most likely the other host sends no CORS headers — paste the schema text into the box above instead.";
          }
        });
    })();
  }

  /* ── 初始: 带 hash 直接进某个面板时也把内容准备好 ── */
  if (input.value.trim()) { doFormat(); }
})();
