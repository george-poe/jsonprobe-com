/* JSON tools front end.
 *
 * all heavy work goes to the Web Worker (see worker.js); if the worker will not start it degrades to a synchronous call, 
 * a worker that fails to load must not take the whole tool down.
 */
(function () {
  "use strict";

  var E = window.JSONEngine;
  var $ = function (id) { return document.getElementById(id); };

  /* ── Worker wrapper ─────────────────────────────────────────────── */
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

  /* run() is the single entry point: worker first, synchronous fallback on failure */
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

  /* ── Small helpers ─────────────────────────────────────────────────── */
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

  /* ── Options ───────────────────────────────────────────────────── */
  function opt() {
    return {
      indent: ($("opt-indent") || {}).value || "2",
      sortKeys:!!(($("opt-sort") || {}).checked),
      minify:!!(($("opt-minify") || {}).checked)
    };
  }

  /* ── Tab switching ───────────────────────────────────────────────── */
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

  /* ── Input area ─────────────────────────────────────────────────── */
  var input = $("input");
  var inputInfo = $("input-info");

  /* Paste-and-go. The tagline on this page says "paste JSON and get it back", so the
     run has to happen without hunting for a button — that sentence is the claim this
     listener exists to keep true. Debounced instead of per-keystroke (a 5 MB format
     costs ~200 ms in the worker; requestAnimationFrame-per-keystroke would queue a
     dozen runs), and switched off above AUTO_MAX where an accidental auto-run would
     burn seconds on a 100 MB file. The button still works at every size. */
  var AUTO_MAX = 8 * 1024 * 1024;
  var autoTimer = null;

  function updateInputInfo() {
    var n = E.byteLen(input.value);
    inputInfo.textContent = n? bytes(n) + " · " + E.countLines(input.value) + " lines": "empty";
    if (n > AUTO_MAX) {
      inputInfo.textContent += " · above the auto-run size, press Format";
    }
    return n;
  }
  updateInputInfo();

  /* one measurement per keystroke, not two: byteLen over 10 MB is not free, and the
     line count has to come from the engine's counter rather than split("\n"), which
     builds a million temporary strings on a million-line paste. */
  input.addEventListener("input", function () {
    var n = updateInputInfo();
    if (autoTimer) clearTimeout(autoTimer);
    if (n > AUTO_MAX) { autoTimer = null; return; }
    autoTimer = setTimeout(function () { autoTimer = null; doFormat(); }, 400);
  });

  /* Drag and drop a .json file — plain browser FileReader, nothing reaches any server */
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

  /* ── Format / validate ──────────────────────────────────────────── */
  var out = $("output"), errBox = $("error"), stats = $("stats");

  /* One link, zero requests: the browser opens GitHub (or the visitor's mail
     client) with a note pre-filled from run diagnostics. The document itself is
     never read here — only its length is. tools/feedback.py audits every call
     site at build time, and test/index.html checks the field caps with a canary
     string, because "we only send the size" is the kind of sentence that rots
     the moment someone adds one more field to make triage easier. */
  function feedbackLink(label, extra) {
    var url = E.reportURL(extra);
    if (!url) return "";
    return '<a class="fb" href="' + esc(url) + '" target="_blank" rel="noopener">' +
           esc(label) + "</a>";
  }

  function feedbackEl(label, extra) {
    var url = E.reportURL(extra);
    if (!url) return null;
    var a = document.createElement("a");
    a.className = "fb";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    return a;
  }

  function showError(err) {
    if (!err) { errBox.hidden = true; errBox.innerHTML = ""; return; }
    // The link rides next to the failure, not in a footer: a parse error is the
    // one moment a visitor both has context and feels the tool let them down.
    err.feedback = feedbackLink("Tell us and we will fix it", {
      bytes: input.value.length,
      error: err.message,
      line: err.line,
      column: err.column
    });
    var pos = (err.line!= null)? ("line " + err.line + ", column " + err.column + ""): "position unknown";
    errBox.hidden = false;
    errBox.innerHTML =
      '<strong>Invalid JSON</strong> — ' + esc(pos) +
      '<div class="err-msg">' + esc(err.message || "") + "</div>" +
      (err.excerpt? '<pre class="err-ex">' + esc(err.excerpt) + "</pre>": "") +
      (err.feedback || "");
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
          // if the stats cannot be computed, say why — otherwise it looks like output went missing.
          $("stats").insertAdjacentHTML("beforeend",
            "<span>Nesting is too deep for the stats walk (" + esc(r.statsUnavailable) +
            ") — the formatted output above is complete." +
            feedbackLink("Tell us", { notice: r.statsUnavailable }) + "</span>");
        }
        $("stats").insertAdjacentHTML("beforeend", "<span>Took <b>" + ms + "</b></span>");
      }
    });
  }

  /* Big output never goes into the DOM in full — past 1 MB we render the first 200 KB and say so.
     but the full result still has to live in lastOutput: the DOM is only a preview, and Copy / Download must not hand out
     a chopped-off preview as the result, which would hand the user invalid JSON. */
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

  /* Clipboard on an http page. `navigator.clipboard` does not exist in an insecure
     context, so a bare call throws synchronously and the button looks broken while
     saying nothing. These pages are served over http until the certificate lands —
     which is precisely when every visitor would have hit it. execCommand is deprecated
     but still works where the async API is absent, so: try modern, fall back, and tell
     the truth if both fail instead of reporting "Copied" on a failed copy. */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var done = false;
    try { done = document.execCommand("copy"); } catch (e) { done = false; }
    document.body.removeChild(ta);
    return !!done;
  }

  function copyText(text, ok, fail) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { legacyCopy(text)? ok(): fail(); });
    } else {
      legacyCopy(text)? ok(): fail();
    }
  }

  /* Worker failures arrive as an object; String() of that prints "[object Object]"
     in the one place the reader needed the actual reason. */
  function errText(e) {
    if (!e) return "Something went wrong.";
    return (typeof e === "object" && e.message)? String(e.message): String(e);
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
    copyText(resultText(), function () { flash($("btn-copy"), "Copied"); },
             function () { flash($("btn-copy"), "Copy did not work — select the text and press Ctrl+C"); });
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

  /* ── Tree view ─────────────────────────────────────────────────── */
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
    // truncation must be announced: quietly drawing half the tree is worse than not truncating.
    if (treeTruncated) {
      var note = el("p", "note",
        "The tree stopped at " + TREE_NODE_CAP.toLocaleString() +
        " nodes. The rest of the document is still there — it is just not drawn."
        + " Use the text view, or Download, for the whole thing.");
      var fb = feedbackEl("too little for you? tell us", { notice: "tree cap", nodes: TREE_NODE_CAP });
      if (fb) note.appendChild(fb);
      treeBox.appendChild(note);
    }
  }
  if ($("tab-tree")) $("tab-tree").addEventListener("click", doTree);

  /* ── JSONPath query ──────────────────────────────────────────── */
  if ($("btn-query")) $("btn-query").addEventListener("click", function () {
    var q = $("path").value;
    var res = $("query-result");
    run("query", { text: input.value, path: q }, function (r) {
      if (!r.ok) { res.className = "outbox err"; res.textContent = errText(r.error); return; }
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
      if (!r.ok) { box.className = "outbox err"; box.textContent = errText(r.error); return; }
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

  /* ── Schema validation ────────────────────────────────────────────── */
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
          // retry on network failure, at most 3 attempts
          if (tries < MAX) { box.textContent = "Attempt " + tries + " failed (" + e.message + "), retrying…"; setTimeout(attempt, 800 * tries); }
          else {
            box.className = "outbox err";
            box.textContent = "Could not fetch the schema (" + MAX + " tries, " + e.message + ").\n" +
              "Most likely the other host sends no CORS headers — paste the schema text into the box above instead.";
          }
        });
    })();
  }

  /* ── Initial state: prepare the panel content when a hash opens a tab directly ── */
  if (input.value.trim()) { doFormat(); }
})();
