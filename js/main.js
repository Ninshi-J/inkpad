"use strict";
const TOOL_NAMES = {
  pen: "Pen", hl: "Highlighter", eraserStroke: "Eraser", eraserPartial: "Partial eraser",
  tape: "Tape", lasso: "Lasso", text: "Text", laser: "Laser",
};
function fmtT(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function syncStatus() {
  $("stZoom").textContent = Math.round(V.zoom * 100) + "%";
  $("stPage").textContent = `Page ${curPage() + 1} of ${S.pages}`;
  $("recDot").style.display = audio.rec ? "inline-block" : "none";
  let a = "";
  if (audio.rec) a = "Recording " + fmtT(recNowMs());
  else if (audio.playing) a = `Playing ${fmtT(playPosMs())} / ${fmtT(audio.totalMs)}`;
  else if (audio.totalMs) a = `Audio ${fmtT(audio.posMs)} / ${fmtT(audio.totalMs)}`;
  $("stAudio").textContent = a;
  $("savedDot").textContent = dirty ? "" : "Saved";
  refreshPageSetupControls();
}

$("stPage").addEventListener("click", () => {
  const input = prompt(`Go to page (1-${S.pages}):`, String(curPage() + 1));
  if (input === null) return;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n)) return;
  const target = Math.min(S.pages, Math.max(1, n));
  V.scroll = (target - 1) * stride();
  clampScroll();
  schedulePdfUpgrade();
  syncStatus();
});
function syncUI() {
  const host = V.popped ? PALB : TB;
  host.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === V.tool));
  host.querySelectorAll(".swatch").forEach(b => b.classList.toggle("active", b.dataset.colorhex === V.colorHex));
  const rb = host.querySelector("#rulerBtn");
  if (rb) {
    const applies = V.tool === "pen" || V.tool === "hl";
    rb.classList.toggle("active", V.ruler && applies);
    rb.style.opacity = applies ? "" : ".45";
  }
  const wd = host.querySelector("#widthDot");
  if (wd) {
    const d = Math.max(4, Math.min(18, V.width + 3));
    wd.style.width = wd.style.height = d + "px";
    wd.style.background = V.colorHex;
  }
  const wr = host.querySelector("#widthRange");
  if (wr) { wr.value = widthToSliderPos(V.width); wr.title = `Pen width: ${V.width}px ( [ ] )`; }
  SB.classList.toggle("hidden", !V.sidebar);
  const mmWasHidden = MM.classList.contains("hidden");
  MM.classList.toggle("hidden", !V.minimap);
  if (mmWasHidden && V.minimap) resizeMinimap(); // was display:none, so it had no size to observe
  $("stTool").textContent = TOOL_NAMES[V.tool] + (V.ruler && (V.tool === "pen" || V.tool === "hl") ? " + ruler" : "");
  syncStatus();
  needsDraw = true;
}

addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- boot ---------------- */
loadKeymap();
loadPalette();
loadColorByTool();
loadTextDefaults();
V.colorHex = V.colorByTool[V.lastColorTool] ?? V.colorHex;
refreshHelp();
buildToolButtons(TB);
buildSelToolbar();
rebuildSidebar();
wireRandomDlg();
wireTimerWidget();
wireStampDlg();
wireFileMenu();
wireDriveMenu();
resize();
resizeMinimap();
new ResizeObserver(resize).observe(wrap);
addEventListener("resize", resize);
new ResizeObserver(resizeMinimap).observe(MM);
initLibrary().then(tryAutoReconnectFs).then(checkDriveForNewerBackup);
setTool("pen");
requestAnimationFrame(frame);

// Service workers need a real origin (http/https, incl. localhost) — silently
// skipped when opened directly as a file:// path.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}
