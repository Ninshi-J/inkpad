"use strict";
// Temporary diagnostic tool for tracking down the iPad "every other stroke" issue — has zero
// effect unless the page is opened with ?debug=1 in the URL. Not meant to stay in the codebase
// long-term; remove this file (and its <script> tag + sw.js cache entry) once the bug is found.
const DEBUG_HUD = new URLSearchParams(location.search).get("debug") === "1";
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
  [copyBtn, clearBtn].forEach(b => b.style.cssText = "font:11px sans-serif;padding:3px 8px;");
  bar.appendChild(copyBtn); bar.appendChild(clearBtn);
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
  addEventListener("touchcancel", e => dbgLog("RAW touchcancel, touches=" + e.touches.length), { capture: true, passive: true });

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

  dbgLog("debug hud active (v2: raw capture listeners + jank detector)");
}
