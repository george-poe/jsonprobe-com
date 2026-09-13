/* Web Worker  —  large files never block the main thread.
 *
 * this is one of the hard differences between this tool and jsonformatter.org / json-indent.com: 
 * they run JSON.parse + JSON.stringify on the main thread, so a few MB of input freezes the page.
 * in a worker, a 100 MB input still leaves the UI scrollable.
 *
 * shares one implementation with engine.js (importScripts) so the two copies cannot drift apart.
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
