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
  dbgLog = (...args) => {
    lines.push(`[${performance.now().toFixed(0)}] ` + args.join(" "));
    if (lines.length > 500) lines.shift();
    body.textContent = lines.join("\n");
    body.scrollTop = body.scrollHeight;
  };
  copyBtn.onclick = () => {
    navigator.clipboard?.writeText(lines.join("\n")).then(
      () => { copyBtn.textContent = "Copied!"; setTimeout(() => copyBtn.textContent = "Copy log", 1000); },
      () => { copyBtn.textContent = "Copy failed"; }
    );
  };
  clearBtn.onclick = () => { lines.length = 0; body.textContent = ""; };

  addEventListener("error", e => dbgLog("JS ERROR:", e.message, "@", (e.filename || "").split("/").pop() + ":" + e.lineno));
  dbgLog("debug hud active");
}
