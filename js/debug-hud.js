"use strict";
// Temporary diagnostic tool for tracking down the iPad "every other stroke" issue — has zero
// effect unless the page is opened with ?debug=1 in the URL. Not meant to stay in the codebase
// long-term; remove this file (and its <script> tag + sw.js cache entry) once the bug is found.
// The installed home-screen icon always opens the plain URL (its manifest start_url has no query
// string), so a URL param alone can't reach it. Visiting ?debug=1 once in a normal Safari tab
// also latches a localStorage flag, which DOES apply to the installed icon too (same origin, same
// storage) — so the panel can follow you into standalone mode. ?debug=0 clears it again.
(() => {
  const p = new URLSearchParams(location.search).get("debug");
  if (p === "1") { try { localStorage.setItem("inkpad.debugHud", "1"); } catch (_) {} }
  if (p === "0") { try { localStorage.removeItem("inkpad.debugHud"); } catch (_) {} }
})();
const DEBUG_HUD = new URLSearchParams(location.search).get("debug") === "1" || localStorage.getItem("inkpad.debugHud") === "1";
let dbgLog = () => {};
if (DEBUG_HUD) {
  const panel = document.createElement("div");
  panel.id = "dbgHud";
  panel.style.cssText = [
    "position:fixed", "left:0", "right:0", "bottom:0", "height:32vh", "z-index:99999",
    "background:rgba(0,0,0,.88)", "color:#4CFF4C", "font:10px/1.4 ui-monospace,monospace",
    "padding:4px 6px", "box-sizing:border-box", "display:flex", "flex-direction:column",
  ].join(";");
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;margin-bottom:4px;flex:none;";
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy log";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  const disableBtn = document.createElement("button");
  disableBtn.textContent = "Disable";
  [copyBtn, clearBtn, disableBtn].forEach(b => b.style.cssText = "font:11px sans-serif;padding:3px 8px;");
  bar.appendChild(copyBtn); bar.appendChild(clearBtn); bar.appendChild(disableBtn);
  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;white-space:pre-wrap;word-break:break-all;";
  panel.appendChild(bar); panel.appendChild(body);
  document.body.appendChild(panel);

  const lines = [];
  // Writing to the DOM (textContent + forcing a scroll-height reflow) on every single call was
  // itself expensive enough to risk being a confound — on a real device, enough main-thread work
  // per event can make iOS stop delivering pencil touches altogether for a stretch, which would
  // look exactly like "the stroke was never captured". Coalescing the actual DOM write into one
  // per animation frame keeps dbgLog() itself cheap regardless of how often it's called.
  let flushScheduled = false;
  function flush() {
    flushScheduled = false;
    body.textContent = lines.join("\n");
    body.scrollTop = body.scrollHeight;
  }
  dbgLog = (...args) => {
    lines.push(`[${performance.now().toFixed(0)}] ` + args.join(" "));
    if (lines.length > 800) lines.shift();
    if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flush); }
  };
  copyBtn.onclick = () => {
    navigator.clipboard?.writeText(lines.join("\n")).then(
      () => { copyBtn.textContent = "Copied!"; setTimeout(() => copyBtn.textContent = "Copy log", 1000); },
      () => { copyBtn.textContent = "Copy failed"; }
    );
  };
  clearBtn.onclick = () => { lines.length = 0; flush(); };
  disableBtn.onclick = () => {
    try { localStorage.removeItem("inkpad.debugHud"); } catch (_) {}
    panel.remove();
  };

  addEventListener("error", e => dbgLog("JS ERROR:", e.message, "@", (e.filename || "").split("/").pop() + ":" + e.lineno));

  // Raw, unconditional listeners at the window/capture level — completely separate from
  // input.js's own logic, so these fire even if something else intercepts the event, stops its
  // propagation, or targets a different element first. If a "missing" stroke shows nothing here
  // either, the browser/OS never dispatched the event to the page at all (system gesture
  // swallowing it, or the touch being dropped outright) — not a bug in this app's own JS.
  ["pointerdown", "pointerup", "pointercancel"].forEach(type => {
    addEventListener(type, e => {
      const t = e.target;
      dbgLog("RAW", type, e.pointerType, e.pointerId, "target=" + (t && (t.id || t.tagName || "?")));
    }, { capture: true, passive: true });
  });
  addEventListener("touchstart", e => dbgLog("RAW touchstart, touches=" + e.touches.length), { capture: true, passive: true });
  addEventListener("touchend", e => dbgLog("RAW touchend, touches=" + e.touches.length), { capture: true, passive: true });
  addEventListener("touchcancel", e => dbgLog("RAW touchcancel, touches=" + e.touches.length), { capture: true, passive: true });
  /* Safari's own gesture events, which no other engine fires. These are the direct evidence for
     the case above: if a stroke goes missing and one of these appears in its place, WebKit took
     the touch for a gesture instead of dispatching it, rather than the touch being lost. They
     should never fire now that the canvas sets touch-action: none — if they do, the CSS is not
     being honoured and that is worth knowing on its own. */
  ["gesturestart", "gesturechange", "gestureend"].forEach(type => {
    addEventListener(type, e => dbgLog("RAW", type, "scale=" + (e.scale != null ? e.scale.toFixed(2) : "?")),
      { capture: true, passive: true });
  });
  // What the browser thinks it may do with a touch on the canvas, read at startup rather than
  // assumed: "auto" here means gestures are still live over the drawing surface.
  addEventListener("load", () => {
    const b = document.getElementById("board");
    if (b) dbgLog("canvas touch-action =", getComputedStyle(b).touchAction,
                  "| body =", getComputedStyle(document.body).touchAction);
  });

  /* A stroke that logs NOTHING — not even on the raw capture listeners above — leaves two very
     different explanations, and until now the log could not tell them apart:

       1. The page was alive and simply never given the event.
       2. The page was not running at all for that moment, so there was nobody to give it to.

     The heartbeat settles it. It ticks once a second from a timer, independent of the app's
     render loop, and prints what the app thinks it is holding. If heartbeats keep ticking through
     the moment a stroke goes missing, the page was awake and the event never arrived — the
     browser or the OS took it. If the heartbeats stop and then resume, the main thread was
     blocked, which is a completely different bug with a completely different fix.

     It also prints whether a pointer capture is still held. A capture that never gets released
     (the previous stroke's pointerup never arriving) is one of the few ways this app could be
     causing its own problem, and this is the only way to see it from outside. */
  let beat = 0;
  setInterval(() => {
    let captured = "?";
    try { captured = [...pointers.keys()].map(id => cv.hasPointerCapture(id)).join(",") || "none"; }
    catch (_) {}
    dbgLog("beat", ++beat,
           "| tracked=" + (typeof pointers !== "undefined" ? pointers.size : "?"),
           "| drag=" + (typeof drag !== "undefined" && drag ? drag.mode : "null"),
           "| capture=" + captured,
           "| visible=" + document.visibilityState);
  }, 1000);

  // Enough of the movement stream to show whether ANY fragment of a missing stroke arrived. Only
  // the first move of each pointer is logged, and the total is reported when it ends, so this
  // stays cheap: logging every move on a real device is itself enough work to become a confound.
  const moveSeen = new Map();
  addEventListener("pointermove", e => {
    const n = (moveSeen.get(e.pointerId) || 0) + 1;
    moveSeen.set(e.pointerId, n);
    if (n === 1) dbgLog("RAW pointermove FIRST", e.pointerType, e.pointerId);
  }, { capture: true, passive: true });
  ["pointerup", "pointercancel"].forEach(type => addEventListener(type, e => {
    const n = moveSeen.get(e.pointerId);
    if (n) dbgLog("   moves in that stroke:", n, "(id " + e.pointerId + ")");
    moveSeen.delete(e.pointerId);
  }, { capture: true, passive: true }));
  addEventListener("touchmove", () => {}, { capture: true, passive: true });
  ["gotpointercapture", "lostpointercapture"].forEach(type => addEventListener(type, e =>
    dbgLog("RAW", type, e.pointerId), { capture: true, passive: true }));

  // Independent jank detector: an iPad's main thread getting blocked for a stretch is a known way
  // for iOS to stop delivering pencil touch events for that window entirely — this would explain
  // a stroke that never even reaches pointerdown. Runs its own rAF loop (not tied to the app's
  // render loop) and flags any gap between frames wider than expected.
  let lastFrameT = performance.now();
  function jankLoop() {
    const now = performance.now();
    const gap = now - lastFrameT;
    if (gap > 80) dbgLog("** JANK: frame gap", gap.toFixed(0) + "ms");
    lastFrameT = now;
    requestAnimationFrame(jankLoop);
  }
  requestAnimationFrame(jankLoop);

  dbgLog("debug hud active (v4: heartbeat + capture state, movement stream, gesture events, jank detector)");
}
