"use strict";
/* ============================================================================
   InkPad — a Notability-style note app in one self-contained HTML file.
   No frameworks, no dependencies, works offline in any modern browser.
   ========================================================================== */

/* ---------------- constants & settings ---------------- */
const PAPERS = { a4: [794, 1123], letter: [816, 1056], a5: [559, 794] };
const PAGE_GAP = 28;
const MAX_PAGES = 500;
let PALETTE = ["#2A2A2A", "#2B579A", "#C43737", "#2E7D46", "#E88C28", "#7846AA"];
// The highlighter gets its own palette (bright/pastel marker tones) rather than sharing the pen's
// — the two tools are used for visually different purposes, so "last 6 colors" for one shouldn't
// mean digging through ink colors while highlighting or vice versa.
let HL_PALETTE = ["#FFD53D", "#8AE68A", "#7EC8FF", "#FF9ECF", "#FFB25E", "#B49CFF"];
const PALETTE_MIN = 2, PALETTE_MAX = 12;
function paletteFor(tool) { return tool === "hl" ? HL_PALETTE : PALETTE; }
function setPaletteFor(tool, arr) { if (tool === "hl") HL_PALETTE = arr; else PALETTE = arr; }
function loadPalette() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.palette") || "null");
    if (Array.isArray(j) && j.length >= PALETTE_MIN && j.every(c => /^#[0-9a-f]{6}$/i.test(c))) PALETTE = j;
  } catch (_) {}
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.palette.hl") || "null");
    if (Array.isArray(j) && j.length >= PALETTE_MIN && j.every(c => /^#[0-9a-f]{6}$/i.test(c))) HL_PALETTE = j;
  } catch (_) {}
}
function savePalette() {
  try { localStorage.setItem("inkpad.palette", JSON.stringify(PALETTE)); } catch (_) {}
  try { localStorage.setItem("inkpad.palette.hl", JSON.stringify(HL_PALETTE)); } catch (_) {}
  scheduleSettingsSave();
}
function refreshPaletteUI() {
  savePalette();
  buildToolButtons(V.popped ? PALB : TB);
}
// Shared "add a color" control used by both the toolbar and the color ring — a real color
// <input> so clicking it opens the OS picker directly, with the pick itself (on commit, not
// while still dragging around in the picker) added to the palette and made current in one step.
// Adds to whichever palette belongs to the currently active tool (see paletteFor).
function buildAddColorInput(onAdded) {
  const wrap = document.createElement("div");
  wrap.className = "add-color-wrap";
  const inp = document.createElement("input");
  inp.type = "color";
  inp.className = "add-color-input";
  inp.title = "Add a custom color";
  inp.value = /^#[0-9a-f]{6}$/i.test(V.colorHex) ? V.colorHex : "#2a2a2a";
  inp.onchange = () => {
    const hex = inp.value.toLowerCase();
    const pal = paletteFor(V.tool);
    if (!pal.includes(hex)) { setPaletteFor(V.tool, [...pal, hex]); refreshPaletteUI(); }
    setColor(hex);
    if (onAdded) onAdded();
  };
  const label = document.createElement("span");
  label.className = "add-color-label";
  label.textContent = "+";
  wrap.append(inp, label);
  return wrap;
}
const HL_ALPHA = 0.38;
const LASER_MS = 900;
const SHAPE_HOLD_MS = 650;

const S = { // document settings (saved)
  paper: "a4", landscape: false, template: "ruled",
  ruleSp: 34, gridSp: 28, outline: true, pages: 1,
  pageStyles: {}, // page index -> { template, ruleSp, gridSp, outline, landscape } overrides; each falls back to the document default when unset
  shapePrefs: {}, // checkbox id -> checked, for the math-shape dialog (e.g. "show side labels") — per notebook, so a Y9 and a Y7 notebook can keep different defaults
};
// Resolves the effective ruling for a given page, honoring any per-page overrides.
function pageStyle(p) {
  const o = S.pageStyles && S.pageStyles[p];
  return {
    template: (o && o.template) || S.template,
    ruleSp: (o && o.ruleSp) || S.ruleSp,
    gridSp: (o && o.gridSp) || S.gridSp,
    outline: (o && o.outline != null) ? o.outline : S.outline,
    landscape: (o && o.landscape != null) ? o.landscape : S.landscape,
  };
}

// Pen width slider uses an exponential (not linear) scale so equal drag distance near the low
// end covers much finer increments than the same distance near the high end — e.g. going from
// hairline to "just a bit thicker" is a tiny slider move, matching how thin-line control matters
// far more than thick-line control in practice.
const PEN_MIN_W = 0.25, PEN_MAX_W = 16, PEN_SLIDER_STEPS = 1000;
function widthToSliderPos(w) {
  const t = Math.log(Math.max(PEN_MIN_W, w) / PEN_MIN_W) / Math.log(PEN_MAX_W / PEN_MIN_W);
  return Math.round(Math.max(0, Math.min(1, t)) * PEN_SLIDER_STEPS);
}
function sliderPosToWidth(pos) {
  const t = Math.max(0, Math.min(PEN_SLIDER_STEPS, pos)) / PEN_SLIDER_STEPS;
  return Math.round(PEN_MIN_W * Math.pow(PEN_MAX_W / PEN_MIN_W, t) * 100) / 100;
}

const V = { // view state
  zoom: 1, scroll: 0, scrollX: 0, tool: "pen", colorHex: "#2A2A2A", width: 3, eraserSize: 12,
  ruler: false, sidebar: true, minimap: true, popped: false, prevTool: "hl",
  // each color-bearing tool remembers its own last-used color independently
  colorByTool: { pen: "#2A2A2A", hl: "#FFD53D", text: "#2A2A2A" },
  lastColorTool: "pen",
  textFont: "sans", textSize: 20, // remembered for the next NEW text box
};

/* ---------------- text box fonts ---------------- */
// pdfAscent is the font's official Adobe AFM ascender, as a fraction of em size (e.g. Helvetica's
// is 718/1000) — the PDF equivalent of the canvas's fontBoundingBoxAscent, and NOT the same number
// (different font, different metrics) — needed to convert a "top of text" world position into the
// baseline coordinate PDF text drawing actually uses. Using the wrong one (or a canvas-tuned guess)
// under/overshoots the baseline, which reads as text drifting off its on-screen position on export.
const FONT_STACKS = {
  sans:  { label: "Sans-serif",  css: 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif', pdf: "Helvetica",  pdfAscent: 0.718 },
  serif: { label: "Serif",       css: 'Georgia, "Times New Roman", Times, serif',                pdf: "TimesRoman", pdfAscent: 0.683 },
  mono:  { label: "Monospace",   css: '"Courier New", ui-monospace, SFMono-Regular, monospace',  pdf: "Courier",    pdfAscent: 0.629 },
  hand:  { label: "Handwritten", css: '"Comic Sans MS", "Segoe Print", cursive',                 pdf: "Helvetica",  pdfAscent: 0.718 },
};
const DEFAULT_FONT_KEY = "sans";
function fontCss(t) { return (FONT_STACKS[t.font] || FONT_STACKS[DEFAULT_FONT_KEY]).css; }
function pdfAscentFor(t) { return (FONT_STACKS[t.font] || FONT_STACKS[DEFAULT_FONT_KEY]).pdfAscent; }

// Dedicated offscreen context for text-width measurement — kept separate from the main canvas
// context so measuring never has to save/restore state around actual drawing.
const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");

// Greedy word-wrap: breaks `text` into lines no wider than `maxWidth` (world-space px) at
// measureCtx's current font. A single word wider than maxWidth is left on its own line rather
// than broken mid-word.
function wrapParagraph(text, maxWidth) {
  if (!text) return [""];
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? cur + " " + word : word;
    if (!cur || measureCtx.measureText(test).width <= maxWidth) cur = test;
    else { lines.push(cur); cur = word; }
  }
  lines.push(cur);
  return lines;
}
// Resolves a text object's stored paragraphs (t.lines) into the actual lines it renders as —
// unchanged when it has no wrap width (legacy/auto-sized boxes), soft-wrapped per paragraph
// when it does. World-space (unscaled by zoom), matching how x/y/size are stored.
function wrappedLines(t) {
  const paras = t.lines.length ? t.lines : [""];
  if (!t.w) return paras;
  measureCtx.font = `${t.size}px ${fontCss(t)}`;
  const out = [];
  for (const para of paras) out.push(...wrapParagraph(para, t.w));
  return out;
}
function setColor(hex) {
  V.colorHex = hex;
  V.colorByTool[V.lastColorTool] = hex;
  try { localStorage.setItem("inkpad.colorByTool", JSON.stringify(V.colorByTool)); } catch (_) {}
  scheduleSettingsSave();
  syncUI();
}
function loadColorByTool() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.colorByTool") || "null");
    if (j && typeof j === "object") Object.assign(V.colorByTool, j);
  } catch (_) {}
}
function saveTextDefaults() {
  try { localStorage.setItem("inkpad.textDefaults", JSON.stringify({ font: V.textFont, size: V.textSize })); } catch (_) {}
  scheduleSettingsSave();
}
function loadTextDefaults() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.textDefaults") || "null");
    if (j && typeof j === "object") {
      if (FONT_STACKS[j.font]) V.textFont = j.font;
      if (Number.isFinite(j.size) && j.size > 0) V.textSize = j.size;
    }
  } catch (_) {}
}

/* ---------------- document model ---------------- */
const doc = {
  strokes: [],  // {tool:'pen'|'hl', color, w, pts:[{x,y,p}], t:audioMs|null, del, bb}
  tapes: [],    // {x,y,w,h, revealed, del}
  texts: [],    // {x,y, color, size, lines:[], del}
  images: [],   // {img:HTMLImageElement, data:dataURL, x,y,w,h, del}
};
let undoStack = [], redoStack = [];
let dirty = false, needsDraw = true;

/* ---------------- audio state ---------------- */
const audio = {
  segments: [],        // {blob, url, startMs, durMs}
  totalMs: 0,
  rec: null,           // MediaRecorder
  recStream: null,
  recStartWall: 0,     // performance.now() at record start
  recBaseMs: 0,        // note-time when recording began
  playing: false,
  el: new Audio(),
  playSeg: -1,
  posMs: 0,            // paused position
};

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const wrap = $("canvasWrap"), cv = $("board"), ctx = cv.getContext("2d");
const TB = $("toolbar"), SB = $("sidebar"), PAL = $("palette"), PALB = $("paletteBody");
const MM = $("mmRail"), mmCv = $("mmCanvas"), mmCtx = mmCv.getContext("2d");
const textEdit = $("textEdit");
let CW = 0, CH = 0, DPR = 1;

function resize() {
  DPR = window.devicePixelRatio || 1;
  CW = wrap.clientWidth || 1200; CH = wrap.clientHeight || 800;
  cv.width = Math.round(CW * DPR);
  cv.height = Math.round(CH * DPR);
  clampScroll(); clampScrollX();
  needsDraw = true;
}
// Observer registration (not just the function defs) is wired up from main.js's boot sequence,
// not here — ResizeObserver can fire its initial callback before every later <script> tag has
// finished executing, and resizeMinimap() below reaches into render.js's mmCache, which hasn't
// loaded yet at this point in the file order. Registering after boot removes that race entirely.

let MMW = 0, MMH = 0, MMDPR = 1;
function resizeMinimap() {
  MMDPR = window.devicePixelRatio || 1;
  MMW = MM.clientWidth || 0; MMH = MM.clientHeight || 0;
  mmCv.width = Math.round(MMW * MMDPR);
  mmCv.height = Math.round(MMH * MMDPR);
  mmCache.clear(); // cached tiles were rasterized for the old rail size
  needsDraw = true;
}
new ResizeObserver(resizeMinimap).observe(MM);

/* ---------------- geometry ---------------- */
const pageW = () => PAPERS[S.paper][S.landscape ? 1 : 0];
const pageH = () => PAPERS[S.paper][S.landscape ? 0 : 1];
// Effective width/height for a SPECIFIC page, honoring a per-page orientation override.
function pageDims(p) {
  const landscape = pageStyle(p).landscape;
  return { w: PAPERS[S.paper][landscape ? 1 : 0], h: PAPERS[S.paper][landscape ? 0 : 1], landscape };
}
// Every page reserves a slot as tall as portrait orientation (the taller of the two, for any
// standard paper), regardless of that page's own orientation — so a per-page landscape/portrait
// override never overlaps neighboring pages, and page-index arithmetic (curPage, scroll, PDF
// export, insert/delete-page shifting) can keep treating `stride()` as one fixed constant.
const stride = () => PAPERS[S.paper][1] + PAGE_GAP;
// While the page fits within the viewport, it stays centered (ignoring scrollX) exactly like
// before — horizontal panning only kicks in once zoomed in far enough that it doesn't fit, the
// same way a native scroll container only shows a scrollbar when content overflows.
const viewX = () => {
  const pxW = pageW() * V.zoom;
  if (pxW <= CW) return Math.max(14, (CW - pxW) / 2);
  return -V.scrollX * V.zoom;
};
const maxScroll = () => Math.max(0, S.pages * stride() - CH / V.zoom + 30);
const maxScrollX = () => Math.max(0, pageW() - CW / V.zoom);

const sx = wx => wx * V.zoom + viewX();
const sy = wy => (wy - V.scroll) * V.zoom;
const wx = px => (px - viewX()) / V.zoom;
const wy = py => py / V.zoom + V.scroll;

function clampScroll() { V.scroll = Math.max(0, Math.min(V.scroll, maxScroll())); }
function clampScrollX() { V.scrollX = Math.max(0, Math.min(V.scrollX, maxScrollX())); }
// Pages appear only when content lands on the last page (keeping one blank
// trailing page), when added manually, or when a PDF import needs them.
function bumpPages(y) {
  const needed = Math.floor(Math.max(0, y) / stride()) + 2;
  if (needed > S.pages) { S.pages = Math.min(needed, MAX_PAGES); markDirty(); }
}
function lastContentPage() {
  let m = -1;
  const scan = (arr, yOf) => arr.forEach(o => { if (!o.del) m = Math.max(m, Math.floor(yOf(o) / stride())); });
  scan(doc.strokes, s => s.bb.y1 - 4);
  scan(doc.tapes, t => t.y + t.h);
  scan(doc.texts, t => t.y);
  scan(doc.images, i => i.y + i.h);
  return m;
}
function curPage() {
  const mid = V.scroll + CH / V.zoom / 2;
  return Math.min(S.pages - 1, Math.max(0, Math.floor(mid / stride())));
}
function setZoom(nz, cx = CW / 2, cy = CH / 2) {
  nz = Math.max(0.3, Math.min(4, nz));
  if (nz === V.zoom) return;
  const wyAt = wy(cy), wxAt = wx(cx);
  V.zoom = nz;
  V.scroll = wyAt - cy / V.zoom;
  clampScroll();
  // While the page fits, staying centred keeps the same world x under the cursor for free — only
  // once zoomed in past that point (panning active) does it need explicitly re-anchoring here too.
  if (pageW() * V.zoom > CW) { V.scrollX = wxAt - cx / V.zoom; clampScrollX(); }
  needsDraw = true; syncUI();
  schedulePdfUpgrade();
}
function markDirty() { dirty = true; needsDraw = true; scheduleAutosave(); scheduleMinimapRegen(); }

/* ---------------- undo / redo ---------------- */
