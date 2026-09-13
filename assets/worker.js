/* Web Worker  —  大文件不卡主线程.
 *
 * 这就是这个工具和 jsonformatter.org / json-indent.com 的硬差异之一: 
 * 它们把 JSON.parse + JSON.stringify 放在主线程上, 几 MB 的输入页面就假死.
 * 放 worker 里, 100 MB 的输入 UI 照样能滚动.
 *
 * 和 engine.js 共用同一份实现(importScripts), 避免两个版本逻辑漂移.
 */
importScripts("engine.js");

self.onmessage = function (ev) {
  var m = ev.data || {};
  var result;
  try {
    if (m.op === "format") {
      result = self.JSONEngine.format(m.text, m.opt);
    } else if (m.op === "query") {
      result = self.JSONEngine.query(m.text, m.path);
    } else if (m.op === "diff") {
      var a, b, err = null;
      try { a = JSON.parse(m.a); } catch (e) { err = "Left side is not valid JSON: " + e.message; }
      if (!err) { try { b = JSON.parse(m.b); } catch (e) { err = "Right side is not valid JSON: " + e.message; } }
      result = err? { ok: false, error: { message: err } }
: { ok: true, changes: self.JSONEngine.diff(a, b) };
    } else {
      result = { ok: false, error: { message: "Unknown operation: " + m.op } };
    }
  } catch (e) {
    result = { ok: false, error: { message: (e && e.message) || String(e) } };
  }
  self.postMessage({ id: m.id, result: result });
};
