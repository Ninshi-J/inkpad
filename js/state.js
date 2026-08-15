"use strict";
/* ============================================================================
   InkPad — a Notability-style note app in one self-contained HTML file.
   No frameworks, no dependencies, works offline in any modern browser.
   ========================================================================== */

/* ---------------- constants & settings ---------------- */
// widescreen: 13.333x7.5in @96dpi (standard 16:9 slide size) — [short, long], same convention as
// every other entry here (portrait uses index0 as width; landscape swaps to the actual 1280x720 shape).
const PAPERS = { a4: [794, 1123], letter: [816, 1056], a5: [559, 794], widescreen: [720, 1280] };
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

// A notebook always starts with exactly one layer — "base" is a stable literal id (not genId())
// so a fresh notebook's activeLayer can point at it deterministically; layers created later via
// the panel get a genId() like everything else in the library.
function defaultLayers() { return [{ id: "base", name: "Layer 1", visible: true }]; }

const S = { // document settings (saved)
  paper: "a4", landscape: false, template: "blank",
  ruleSp: 34, gridSp: 28, outline: true, pages: 1,
  pageStyles: {}, // page index -> { template, ruleSp, gridSp, outline, landscape } overrides; each falls back to the document default when unset
  shapePrefs: {}, // checkbox id -> checked, for the math-shape dialog (e.g. "show side labels") — per notebook, so a Y9 and a Y7 notebook can keep different defaults
  layers: defaultLayers(), // [{id, name, visible}] — every stroke/text/image/tape/timer carries a `layer` id pointing into this list
  activeLayer: "base", // which layer new objects get created on
};
// Resolves S.activeLayer defensively — falls back to the first layer if the active one was
// deleted (or, for a notebook saved before layers existed, is simply absent).
function currentLayerId() {
  if (S.layers && S.layers.some(l => l.id === S.activeLayer)) return S.activeLayer;
  return (S.layers && S.layers[0] && S.layers[0].id) || "base";
}
// An object whose layer isn't found at all (shouldn't normally happen once migration has run,
// see deserialize()) defaults to visible rather than disappearing outright.
function isLayerVisible(layerId) {
  if (!S.layers || !S.layers.length) return true;
  const l = S.layers.find(x => x.id === layerId);
  return !l || l.visible !== false;
}
// Used by paste/duplicate-into-stamp paths: keeps a copied object on its original layer when
// that layer still exists here, falling back to the active layer when it doesn't — e.g. a stamp
// or clipboard item created in a different notebook, whose layer ids mean nothing in this one.
function resolveLayerId(id) {
  return (id && S.layers.some(l => l.id === id)) ? id : currentLayerId();
}
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
  ruler: false, sidebar: true, minimap: true, layersPanel: false, popped: false, prevTool: "hl",
  teachMode: false,
  // each color-bearing tool remembers its own last-used color independently
  colorByTool: { pen: "#2A2A2A", hl: "#FFD53D", text: "#2A2A2A" },
  lastColorTool: "pen",
  // pen and the highlighter each remember their own thickness (they used to share `width`
  // outright — see setToolWidth/setTool) — width/eraserSize above stay as the CURRENT tool's
  // value (kept in sync on every tool switch), same dual role V.colorHex already plays for
  // colorByTool.
  widthByTool: { pen: 3, hl: 3 }, lastWidthTool: "pen",
  eraserSizeByTool: { eraserStroke: 12, eraserPartial: 12 },
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

/* Breaks a line into the smallest pieces wrapping is allowed to separate. A whole "$...$" run is
   ONE atom: splitting it would strand its delimiters on different lines, and each half — no longer
   having a matching "$" — stops being math and renders as raw LaTeX. Spaces are kept as their own
   atoms so a break can consume one rather than leaving it dangling at the end of a line. */
function textAtoms(line) {
  const atoms = [];
  for (const run of splitMathRuns(line)) {
    if (run.math !== undefined) { atoms.push({ s: "$" + run.math + "$", math: run.math }); continue; }
    for (const part of run.text.split(/( +)/)) {
      if (part) atoms.push({ s: part, space: part[0] === " " });
    }
  }
  return atoms;
}
/* Width an atom actually occupies once drawn. Math is measured at its RENDERED size, not at the
   width of its LaTeX source — "$\frac{1}{2}$" is 13 characters of source that draws about as wide
   as one, so measuring the source made a box wrap several words early and look badly overfull.
   While a span is still rasterizing getMathSpan returns null and the source width stands in; the
   render sets needsDraw when it lands, so the next frame re-wraps with the real figure. */
function atomWidth(a, t) {
  if (a.math !== undefined && t) {
    const span = getMathSpan(a.math, mathSizePx(t.size), t.color);
    if (span && span.w && !span.failed) return span.w;
  }
  return measureCtx.measureText(a.s).width;
}
// Greedy word-wrap: breaks `text` into lines no wider than `maxWidth` (world-space px) at
// measureCtx's current font. A single word (or one "$...$" formula) wider than maxWidth is left
// on its own line rather than broken up. `t` is the text object, needed only to measure math at
// its rendered size; without it math falls back to its source width.
function wrapParagraph(text, maxWidth, t) {
  if (!text) return [""];
  const lines = [];
  let cur = "", curW = 0;
  for (const a of textAtoms(text)) {
    // A wrap break already consumed the gap, so a CONTINUATION line shouldn't open with it. A
    // paragraph's own leading spaces are different: with no real indent feature, typed spaces are
    // how a list or a sub-question gets stepped in, and dropping them flattened the whole box to
    // the left margin. Only skip the gap once this paragraph has already produced a line.
    if (!cur && a.space && lines.length) continue;
    const w = atomWidth(a, t);
    if (cur && !a.space && curW + w > maxWidth) {
      lines.push(cur.replace(/ +$/, ""));
      cur = a.s; curW = w;
      continue;
    }
    cur += a.s; curW += w;
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
  for (const para of paras) out.push(...wrapParagraph(para, t.w, t));
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
// Sets a specific tool's remembered color without disturbing V.lastColorTool (which tool is
// "active for color" right now) — setColor() always writes to whichever tool that is, which
// isn't safe to reuse from the settings dialog (e.g. setting the highlighter's default color
// while the pen is the active tool would otherwise silently overwrite the pen's color instead).
function setToolDefaultColor(tool, hex) {
  V.colorByTool[tool] = hex;
  if (V.lastColorTool === tool) V.colorHex = hex;
  try { localStorage.setItem("inkpad.colorByTool", JSON.stringify(V.colorByTool)); } catch (_) {}
  scheduleSettingsSave();
  syncUI();
}
// Sets a specific tool's remembered width without disturbing V.lastWidthTool (mirrors
// setToolDefaultColor's relationship to V.lastColorTool) — used by the settings dialog to set
// e.g. the highlighter's thickness while the pen is the active tool.
function setToolWidth(tool, w) {
  V.widthByTool[tool] = w;
  if (V.lastWidthTool === tool) V.width = w;
  savePenDefaults();
}
// Same idea for the two erasers — unlike width there's no "current tool" mirror ambiguity to
// worry about here (nothing outside the eraser tools themselves ever reads V.eraserSize), so
// this can just always write straight through.
function setEraserToolSize(tool, size) {
  V.eraserSizeByTool[tool] = size;
  if (V.tool === tool) V.eraserSize = size;
  saveEraserDefaults();
}
// Pen/highlighter width and eraser size were previously pure in-memory V fields with no
// persistence at all (reset to their hardcoded initial values on every reload) — these follow
// the exact same device/user-level save-on-change pattern saveTextDefaults() already uses.
// Pen and highlighter used to share one plain `width` value; each now remembers its own.
function savePenDefaults() {
  try { localStorage.setItem("inkpad.penDefaults", JSON.stringify({ widthByTool: V.widthByTool })); } catch (_) {}
  scheduleSettingsSave();
}
function loadPenDefaults() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.penDefaults") || "null");
    if (j && j.widthByTool && typeof j.widthByTool === "object") {
      for (const t of ["pen", "hl"]) if (Number.isFinite(j.widthByTool[t]) && j.widthByTool[t] > 0) V.widthByTool[t] = j.widthByTool[t];
    } else if (j && Number.isFinite(j.width) && j.width > 0) {
      // Pre-split save (single shared width) — seed both tools from it rather than losing it.
      V.widthByTool.pen = V.widthByTool.hl = j.width;
    }
    V.width = V.widthByTool[V.lastWidthTool];
  } catch (_) {}
}
// The two erasers ("whole stroke" and "partial") used to share one plain `eraserSize` value;
// each now remembers its own, same split as pen/highlighter above.
function saveEraserDefaults() {
  try { localStorage.setItem("inkpad.eraserDefaults", JSON.stringify({ sizeByTool: V.eraserSizeByTool })); } catch (_) {}
  scheduleSettingsSave();
}
function loadEraserDefaults() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.eraserDefaults") || "null");
    if (j && j.sizeByTool && typeof j.sizeByTool === "object") {
      for (const t of ["eraserStroke", "eraserPartial"]) if (Number.isFinite(j.sizeByTool[t]) && j.sizeByTool[t] > 0) V.eraserSizeByTool[t] = j.sizeByTool[t];
    } else if (j && Number.isFinite(j.size) && j.size > 0) {
      // Pre-split save (single shared size) — seed both tools from it rather than losing it.
      V.eraserSizeByTool.eraserStroke = V.eraserSizeByTool.eraserPartial = j.size;
    }
    if (V.tool === "eraserStroke" || V.tool === "eraserPartial") V.eraserSize = V.eraserSizeByTool[V.tool];
  } catch (_) {}
}

/* ---------------- tape defaults (device/user-level, like shapeDefaults/the keymap — not tied
   to any one notebook). Tape has no drag-to-size click-to-place path today the way timer chips
   do; a plain click with the tape tool (see "tapeMaybe" in input.js) now places one at this
   default size instead of doing nothing. */
const TAPE_DEFAULTS_FALLBACK = { w: 140, h: 32, color: "#FFD682" };
let tapeDefaults = { ...TAPE_DEFAULTS_FALLBACK };
function loadTapeDefaults() {
  tapeDefaults = { ...TAPE_DEFAULTS_FALLBACK };
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.tapeDefaults") || "null");
    if (j && typeof j === "object") Object.assign(tapeDefaults, j);
  } catch (_) {}
}
function saveTapeDefaults() {
  try { localStorage.setItem("inkpad.tapeDefaults", JSON.stringify(tapeDefaults)); } catch (_) {}
  scheduleSettingsSave();
}

/* ---------------- timer/stopwatch chip defaults (device/user-level) — the placed chip's size
   (previously the hardcoded TIMER_OBJ_W/H constants) and the duration a new countdown's
   duration-picker dialog starts pre-filled with. */
const TIMER_OBJ_DEFAULTS_FALLBACK = { w: 130, h: 20, durationMs: 300000 };
let timerObjDefaults = { ...TIMER_OBJ_DEFAULTS_FALLBACK };
function loadTimerObjDefaults() {
  timerObjDefaults = { ...TIMER_OBJ_DEFAULTS_FALLBACK };
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.timerObjDefaults") || "null");
    if (j && typeof j === "object") Object.assign(timerObjDefaults, j);
  } catch (_) {}
}
function saveTimerObjDefaults() {
  try { localStorage.setItem("inkpad.timerObjDefaults", JSON.stringify(timerObjDefaults)); } catch (_) {}
  scheduleSettingsSave();
}

/* ---------------- document model ---------------- */
const doc = {
  strokes: [],  // {tool:'pen'|'hl', color, w, pts:[{x,y,p}], t:audioMs|null, del, bb}
  tapes: [],    // {x,y,w,h, color, revealed, del} — color absent on tapes created before it existed
  texts: [],    // {x,y, color, size, lines:[], del}
  images: [],   // {img:HTMLImageElement, data:dataURL, x,y,w,h, del}
  // A timer ("down") counts down from durationMs and chimes at zero; a stopwatch ("up") just
  // counts up with no target — same shape either way, distinguished only by `mode`. baseMs is
  // elapsed time accumulated across pause/resume; startWall (performance.now() at last start,
  // live-only, not persisted) plus baseMs gives current elapsed while running — same pattern as
  // the floating timer widget's own `timer` object in js/timer.js, just per-object instead of global.
  timers: [],   // {x,y,w,h, mode:'down'|'up', durationMs, running, baseMs, startWall, del}
  // Unlike every other generated diagram, a table is a live object rather than a placed image —
  // its cells are typed into on the canvas after it's made. See js/table-obj.js.
  tables: [],   // {x,y,w,h, cells[][], colW[], rowH[], headRows, headCols, spans, fontSize, ...}
};
/* Every object array, paired with the selection `kind` that names it. Several things need to walk
   the whole document without caring what's in it — grouping, most of all — and each of them
   growing its own list of the six arrays is how one of them ends up quietly missing tables. */
const DOC_ARRAYS = [
  ["stroke", "strokes"], ["tape", "tapes"], ["text", "texts"],
  ["image", "images"], ["timer", "timers"], ["table", "tables"],
];
function forEachDocObject(fn) {
  for (const [kind, key] of DOC_ARRAYS) for (const ref of doc[key]) fn(ref, kind);
}

/* ---------------- groups ----------------
   A group is a tag, not a container: every member carries the same `grp` string and the objects
   stay exactly where they were in their own arrays. That's what keeps grouping from touching
   drawing, hit-testing, export, layers or z-order at all — the only thing that changes is how a
   click turns into a selection.

   Groups are flat. Grouping a selection that already contains groups retags all of it into one new
   group rather than nesting, and ungrouping is a single step back to loose objects. Nesting would
   mean a click had to decide WHICH level you meant, which needs an enter/exit-group mode to answer
   — a lot of interface for a whiteboard. */
let groupSeq = 0;
// Random suffix, not just a counter: ids have to stay distinct across a paste from another
// notebook, where the other document's counter started at 1 as well.
const newGroupId = () => `g${(++groupSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
/* Pulls in the rest of whatever group each picked item belongs to. Runs on the way OUT of every
   selection gesture rather than inside them, so click, ctrl+click and lasso all get it without
   each one reimplementing it. Order and identity are preserved: an item already in the list is
   never added twice, so selection-order-sensitive things (the ink toolbar reads items[0]) are
   unaffected for selections that contain no groups at all. */
function expandToGroups(items) {
  const seen = new Set(items.map(it => it.ref));
  const out = items.slice();
  const ids = new Set(items.map(it => it.ref.grp).filter(Boolean));
  if (!ids.size) return out;
  forEachDocObject((ref, kind) => {
    if (ref.del || seen.has(ref) || !ids.has(ref.grp)) return;
    if (!isLayerVisible(ref.layer)) return; // a hidden layer's objects aren't selectable on their own either
    seen.add(ref); out.push({ kind, ref });
  });
  return out;
}
/* Copies form their OWN group rather than joining the original's. Pasting a grouped diagram twice
   must give two groups you can move independently — reusing the id would silently weld every copy
   to the original, and clicking any of them would select the lot. Ids are remapped as a set, so a
   selection spanning two groups still comes out as two. */
function remapGroupIds(refs) {
  const fresh = new Map();
  for (const ref of refs) {
    if (!ref || !ref.grp) continue;
    if (!fresh.has(ref.grp)) fresh.set(ref.grp, newGroupId());
    ref.grp = fresh.get(ref.grp);
  }
}
// The selection is "a whole group" when every item carries the same non-empty id. That's the test
// for offering Ungroup, and it's deliberately stricter than "contains a group": a selection of one
// group plus a stray stroke is a candidate for Group, not Ungroup.
function selGroupId() {
  if (sel.items.length < 2) return null;
  const id = sel.items[0].ref.grp;
  return id && sel.items.every(it => it.ref.grp === id) ? id : null;
}
function timerObjElapsedMs(t) { return t.running ? t.baseMs + (performance.now() - t.startWall) : t.baseMs; }
function timerObjRemainingMs(t) { return Math.max(0, t.durationMs - timerObjElapsedMs(t)); }
let undoStack = [], redoStack = [];
let dirty = false, needsDraw = true;
// Lets undo()/redo() detect "back to exactly what was last saved" (e.g. draw a stroke, immediately
// undo it) and clear `dirty` again instead of leaving a no-op edit looking like a real change --
// see markDirty()/resetCleanMarkers() and undo()/redo() in history.js for how these are used.
// cleanUndoTop is compared by REFERENCE, not just cleanUndoDepth by count: undo()/redo() only ever
// move existing entries between undoStack/redoStack (never create new ones), while any genuinely
// new edit always pushes a fresh entry object -- so two different edit sequences that happen to
// leave the stack the same LENGTH can still be told apart by whether the top entry is the same object.
let cleanUndoDepth = 0, cleanUndoTop = null;
function resetCleanMarkers() {
  cleanUndoDepth = undoStack.length;
  cleanUndoTop = undoStack.length ? undoStack[undoStack.length - 1] : null;
}
// A handful of things dirty the doc WITHOUT ever pushing an undo entry (page-setup dropdowns,
// tape-reveal-by-click, the automatic page-count grow in bumpPages) -- undo()/redo() can't walk
// those back, so the stack-position check in reconcileCleanState() would be none the wiser and
// could wrongly call the doc clean while one of these is still unsaved. Call sites for exactly
// those cases call this (alongside their normal markDirty()) to rule that out until the next save.
function invalidateCleanMarker() { cleanUndoDepth = -1; }

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
const LP = $("layersPanel");
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

/* ---------------- file naming ----------------
   Windows, macOS and iOS each reject a different set of characters in a filename; this strips the
   union of them plus control characters, collapses the whitespace that leaves behind, and trims
   trailing dots and spaces (Windows silently drops those, so "Ch. 4." would save under a name
   that doesn't match what was asked for). Returns "" when nothing usable survives, so every
   caller can fall back rather than producing a file called ".pdf". */
function safeFileStem(name, maxLen = 60) {
  return String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .replace(/[. ]+$/, "")
    .trim();
}
// The active notebook's name as a file stem — what exports and recordings default to, so a
// downloaded file says which notebook it came from instead of every one of them being "notes".
function notebookFileStem(fallback = "notes") {
  try {
    const nb = libNotebooks.find(n => n.id === activeNotebookId);
    if (nb && nb.name) return safeFileStem(nb.name) || fallback;
  } catch (_) {}
  return fallback;
}

/* ---------------- geometry ---------------- */
const pageW = () => PAPERS[S.paper][S.landscape ? 1 : 0];
const pageH = () => PAPERS[S.paper][S.landscape ? 0 : 1];
// Effective width/height for a SPECIFIC page, honoring a per-page orientation override.
function pageDims(p) {
  const landscape = pageStyle(p).landscape;
  return { w: PAPERS[S.paper][landscape ? 1 : 0], h: PAPERS[S.paper][landscape ? 0 : 1], landscape };
}
/* Every page reserves the same slot height, so page-index arithmetic (curPage, scroll, PDF
   export, insert/delete-page shifting) stays a single division by a constant. That slot has to
   fit the tallest page the document can contain — but only the tallest one it ACTUALLY contains.
   Reserving portrait height unconditionally left a portrait-sized hole under every page of an
   all-landscape document: widescreen 16:9 draws 720 tall, so each page sat in a 1308 slot with
   588px of blank beneath it. Portrait is the taller orientation for every paper here, so any
   portrait page anywhere (global or a per-page override) still takes the tall slot and nothing
   can overlap. */
function documentIsAllLandscape() {
  if (!S.landscape) return false;
  const o = S.pageStyles;
  if (o) for (const k in o) if (o[k] && o[k].landscape === false) return false;
  return true;
}
const stride = () => PAPERS[S.paper][documentIsAllLandscape() ? 0 : 1] + PAGE_GAP;

/* Which page a box belongs to — by how much of it is on each page, not by where its top edge is.

   Attributing by the top edge alone means nudging something one pixel above a page boundary hands
   it to the PREVIOUS page while 99.9% of it is still on this one. Export then places it relative
   to that page's top, a whole stride further down than the paper is tall, so it lands entirely off
   the bottom of a page it was never on and is missing from the page it was: an imported PDF that
   renders on page 1 and nowhere after it. A pixel of slop should not be able to do that. */
function pageIndexForBox(y, h) {
  const st = stride();
  const last = Math.max(0, S.pages - 1);
  const first = Math.max(0, Math.min(last, Math.floor(y / st)));
  if (!(h > 0)) return first;
  let best = first, bestOverlap = -Infinity;
  for (let p = first; p <= last; p++) {
    const top = p * st;
    if (top > y + h) break;
    const overlap = Math.min(y + h, top + pageDims(p).h) - Math.max(y, top);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = p; }
  }
  return best;
}
const pageIndexForObject = o => pageIndexForBox(o.y, o.h || 0);

/* ---------------- keeping content on its page when the page grid changes ----------------
   Object positions are absolute world y; which page something is ON is derived from that by
   dividing by stride(). So anything that changes stride — the paper size, the orientation, a
   per-page orientation override — moves the page boundaries out from under content that doesn't
   move with them. Page 1 starts at 0 either way and looks fine, which is why the symptom is always
   "everything after the first page is wrong": at each page boundary the drift grows by another
   whole stride, until later pages have slid off the end of the document entirely.

   Each object is put back where it was on ITS page: same page index, same offset down that page.
   The offset is deliberately NOT rescaled — a shorter page means content can now hang past the
   bottom, but that is the honest consequence of choosing a smaller page, whereas squashing the
   spacing would silently move ink relative to the ink beside it. */
function reflowPagesForStride(was, now) {
  if (!Number.isFinite(was) || !Number.isFinite(now) || Math.abs(was - now) < 0.5) return false;
  const moveY = y => {
    const p = Math.max(0, Math.floor(y / was));
    return y - p * was + p * now;
  };
  const shift = (o, kind) => {
    const y = kind === "stroke" ? o.pts[0].y : o.y;
    shiftObject(o, kind, 0, moveY(y) - y);
  };
  for (const s of doc.strokes) shift(s, "stroke");
  for (const arr of [doc.tapes, doc.texts, doc.images, doc.timers, doc.tables]) {
    for (const o of arr) shift(o, "");
  }
  return true;
}
/* ---------------- snapping a dragged selection to its page ----------------
   An imported page is meant to sit exactly on the page it fills, and by hand it never quite does —
   a pixel out is invisible on screen and changes which page the thing belongs to. So the page's own
   edges and centre lines pull anything dragged near them.

   Given where the selection WOULD land, returns the small correction that puts it on the nearest
   guide. Both axes are independent, so an edge can catch without the other axis being disturbed.
   The threshold is in screen pixels, converted here, so it feels identical at every zoom. */
const PAGE_SNAP_PX = 7;
function pageSnapOffset(box) {
  const tol = PAGE_SNAP_PX / Math.max(0.05, V.zoom);
  const p = pageIndexForBox(box.y0, box.y1 - box.y0);
  const dims = pageDims(p), top = p * stride();
  // Each pair is "this guide line" against "the edge of the selection that would meet it".
  const pick = pairs => {
    let best = 0, bestD = tol;
    for (const [guide, edge] of pairs) {
      const d = guide - edge;
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = d; }
    }
    return best;
  };
  return {
    dx: pick([[0, box.x0], [dims.w, box.x1], [dims.w / 2, (box.x0 + box.x1) / 2]]),
    dy: pick([[top, box.y0], [top + dims.h, box.y1], [top + dims.h / 2, (box.y0 + box.y1) / 2]]),
  };
}
// Wraps any change that can alter the page pitch, so the content follows it. Reads stride() before
// and after rather than being told what changed, which means a new kind of page setting can never
// forget to opt in.
function withPageGrid(fn) {
  const was = stride();
  fn();
  if (reflowPagesForStride(was, stride())) { bumpPages(contentBottom()); needsDraw = true; }
}
// How far down the document anything actually reaches — used after a reflow to make sure the page
// count still covers the content, which a change of pitch can push past the last page.
function contentBottom() {
  let y = 0;
  for (const s of doc.strokes) if (!s.del && s.bb) y = Math.max(y, s.bb.y1);
  for (const arr of [doc.tapes, doc.texts, doc.images, doc.timers, doc.tables]) {
    for (const o of arr) if (!o.del) y = Math.max(y, o.y + (o.h || 0));
  }
  return y;
}
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

/* Teaching Mode shows a page at a time. Every scroll path in the app ends up here, so confining
   the view to one page is done here rather than in each of them: the visible strip is kept inside
   the page being taught from, and a scroll that runs past either end moves to the neighbouring page
   aligned to the edge it arrived from — never a view with the bottom of one page above the top of
   the next, which is the thing that reads as losing your place mid-lesson.

   A page taller than the screen can still be scrolled through; it is only the boundary between two
   pages that can't be parked on. teachPage is held rather than derived so that a page you have
   scrolled to the bottom of doesn't silently become the next one. */
let teachPage = 0;
let teachScrollWas = 0; // where the view sat after the previous clamp — see the note below
function setTeachPage(p) { teachPage = Math.max(0, Math.min(S.pages - 1, p)); }
const teachPageTop = () => teachPage * stride();
const teachPageBottom = () => teachPageTop() + Math.max(0, pageDims(teachPage).h - CH / V.zoom);
function teachScrollTo(p, toBottom) {
  setTeachPage(p);
  V.scroll = toBottom ? teachPageBottom() : teachPageTop();
  teachScrollWas = V.scroll;
}
function clampScrollTeaching(gesture) {
  setTeachPage(teachPage);
  const EPS = 0.5;
  /* Anything that isn't a scroll GESTURE is a jump — go to page 7, Home, End, opening a file — and
     a jump lands where it was asked to. Only the wheel and a finger dragging the page are held to
     the rule below; deciding by how far the scroll moved instead would make a firm flick
     indistinguishable from "go to the next page". */
  if (!gesture) {
    setTeachPage(Math.floor((V.scroll + (CH / V.zoom) / 2) / stride()));
    V.scroll = Math.max(teachPageTop(), Math.min(V.scroll, teachPageBottom()));
    teachScrollWas = V.scroll;
    return;
  }
  const top = teachPageTop(), bottom = teachPageBottom();
  /* The page has to be scrolled THROUGH before it can be left. A scroll that overshoots the end of
     the page stops at that end; only a further scroll from there moves on. Without this, one firm
     flick on a page taller than the screen skipped to the next page and took everything below the
     fold with it — which is the half of the page you were about to teach from. */
  if (V.scroll > bottom + EPS) {
    if (teachScrollWas >= bottom - EPS && teachPage < S.pages - 1) teachScrollTo(teachPage + 1, false);
    else V.scroll = bottom;
  } else if (V.scroll < top - EPS) {
    if (teachScrollWas <= top + EPS && teachPage > 0) teachScrollTo(teachPage - 1, true);
    else V.scroll = top;
  } else {
    V.scroll = Math.max(top, Math.min(V.scroll, bottom));
  }
  teachScrollWas = V.scroll;
}
// `gesture` marks the wheel and the touch pan — the two paths where the scroll is being nudged
// rather than sent somewhere. It only means anything in Teaching Mode.
function clampScroll(gesture) {
  V.scroll = Math.max(0, Math.min(V.scroll, maxScroll()));
  if (V.teachMode) clampScrollTeaching(gesture === true);
}
function clampScrollX() { V.scrollX = Math.max(0, Math.min(V.scrollX, maxScrollX())); }
// Pages appear only when content lands on the last page (keeping one blank
// trailing page), when added manually, or when a PDF import needs them.
function bumpPages(y) {
  const needed = Math.floor(Math.max(0, y) / stride()) + 2;
  // Growing the page count isn't itself undo-tracked (whatever triggered it, e.g. a stroke, is --
  // undoing THAT doesn't shrink S.pages back down), so undoing the triggering action alone would
  // otherwise leave the doc looking "clean" while the page count stays permanently grown.
  if (needed > S.pages) { S.pages = Math.min(needed, MAX_PAGES); markDirty(); invalidateCleanMarker(); }
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
// fromUndo is set only by applyEntry() (undo/redo replaying a past entry) -- every other call site
// is a genuine new change, which undo/redo can never walk back past (a real new edit always clears
// redoStack -- see pushUndo), so it always invalidates any "back to clean" possibility.
function markDirty() { dirty = true; needsDraw = true; scheduleAutosave(); scheduleMinimapRegen(); }

/* ---------------- undo / redo ---------------- */
