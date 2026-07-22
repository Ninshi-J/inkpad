"use strict";
const ACTIONS = [
  { id: "pen",       label: "Pen",                    key: "q",   run: () => setTool("pen") },
  { id: "hl",        label: "Highlighter",            key: "w",   run: () => setTool("hl") },
  { id: "eraser",    label: "Eraser",                 key: "e",   run: () => setTool("eraserStroke") },
  { id: "eraserP",   label: "Partial eraser",         key: "r",   run: () => setTool("eraserPartial") },
  { id: "lasso",     label: "Lasso",                  key: "a",   run: () => setTool("lasso") },
  { id: "tape",      label: "Tape",                   key: "-",   run: () => setTool("tape") },
  { id: "text",      label: "Text",                   key: "t",   run: () => setTool("text") },
  { id: "laser",     label: "Laser",                  key: "f",   run: () => setTool("laser") },
  { id: "ruler",     label: "Ruler toggle",           key: "g",   run: () => { V.ruler = !V.ruler; } },
  { id: "lastTool",  label: "Swap to last tool",      key: "tab", run: () => swapTool() },
  { id: "colorNext", label: "Next preset color",      key: "c",   run: () => cycleColor(1) },
  { id: "colorPrev", label: "Previous preset color",  key: "x",   run: () => cycleColor(-1) },
  { id: "colorPick", label: "Color picker at cursor", key: "v",   run: () => openColorPop() },
  { id: "sizeDown",  label: "Width / eraser size −",  key: "s",   run: () => adjustSize(-1) },
  { id: "sizeUp",    label: "Width / eraser size +",  key: "d",   run: () => adjustSize(1) },
  { id: "flipH",      label: "Flip selection horizontal", key: "b", run: () => flipSelection("x") },
  { id: "flipV",      label: "Flip selection vertical",   key: "n", run: () => flipSelection("y") },
  { id: "rotate90",   label: "Rotate selection 90°",      key: "z", run: () => rotateSelection90() },
  { id: "random",     label: "Random picker",              key: "h", run: () => openRandomDlg() },
  { id: "timer",      label: "Timer / stopwatch toggle",   key: "u", run: () => toggleTimerWidget() },
];
let keymap = {};
function defaultKeymap() { keymap = {}; ACTIONS.forEach(a => keymap[a.key] = a.id); }
function loadKeymap() {
  defaultKeymap();
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.keymap") || "null");
    if (j && typeof j === "object") {
      keymap = {};
      for (const [k, id] of Object.entries(j)) if (ACTIONS.some(a => a.id === id)) keymap[k] = id;
      ACTIONS.forEach(a => { if (!Object.values(keymap).includes(a.id)) keymap[a.key] = a.id; });
    }
  } catch (_) {}
}
function saveKeymap() { try { localStorage.setItem("inkpad.keymap", JSON.stringify(keymap)); } catch (_) {} scheduleSettingsSave(); }
function keyFor(id) { return Object.keys(keymap).find(k => keymap[k] === id) || "—"; }

// A device/user preference (like the keymap), not a per-notebook one — a stylus owner wants this
// on for every notebook, always, not re-toggled per document. Off by default so touch-drawing
// still works out of the box for anyone without a stylus.
let pencilOnly = false;
function loadPencilOnlyPref() { pencilOnly = localStorage.getItem("inkpad.pencilOnly") === "1"; }
function savePencilOnlyPref() { try { localStorage.setItem("inkpad.pencilOnly", pencilOnly ? "1" : "0"); } catch (_) {} }

function cycleColor(dir) {
  const pal = paletteFor(V.tool);
  const i = pal.indexOf(V.colorHex);
  const n = i === -1 ? (dir > 0 ? 0 : pal.length - 1) : (i + dir + pal.length) % pal.length;
  setColor(pal[n]);
}
function adjustSize(d) {
  if (V.tool.startsWith("eraser")) V.eraserSize = Math.max(4, Math.min(48, V.eraserSize + d * 2));
  // Multiplicative (not additive) step, matching the slider's exponential scale — keeps each
  // keypress a meaningful relative change whether you're nudging a hairline or a thick line.
  else V.width = Math.max(PEN_MIN_W, Math.min(PEN_MAX_W, Math.round(V.width * Math.pow(1.25, d) * 100) / 100));
  needsDraw = true; syncUI();
}

/* color ring — a radial picker centered on the cursor */
let lastClient = { x: 220, y: 220 };
wrap.addEventListener("pointermove", e => { lastClient = { x: e.clientX, y: e.clientY }; }, { passive: true });

const RING_SWATCH = 32, RING_GAP = 6;
// How many slots the ring needs right now (each palette color, plus an "add" slot if there's
// room for one more) and the radius that gives adjacent swatches at least RING_SWATCH+RING_GAP
// of chord spacing at that count, so a full 12-color palette doesn't overlap itself.
function ringSlotCount() { const n = paletteFor(V.tool).length; return n + (n < PALETTE_MAX ? 1 : 0); }
function ringRadius(n) { return Math.max(58, Math.min(120, (RING_SWATCH + RING_GAP) / (2 * Math.sin(Math.PI / n)))); }
// Keeps the ring's center far enough from the viewport edge that every swatch stays fully
// on-screen, the radial equivalent of clamping a rectangular popup's corner.
function computeRingCenter(clientX, clientY, outerReach, viewW, viewH, margin = 6) {
  const reach = outerReach + margin;
  const cx = Math.min(viewW - reach, Math.max(reach, clientX));
  const cy = Math.min(viewH - reach, Math.max(reach, clientY));
  return { cx, cy };
}

function buildColorRing(pop, center) {
  pop.innerHTML = "";
  const swatchSize = RING_SWATCH;
  const ringPalette = paletteFor(V.tool);
  const canAdd = ringPalette.length < PALETTE_MAX;
  const n = ringSlotCount();
  const R = ringRadius(n);
  const startAngle = -Math.PI / 2; // first item at the top, going clockwise
  const angleStep = (2 * Math.PI) / n;
  const place = (el, i) => {
    const angle = startAngle + i * angleStep;
    el.style.left = Math.round(center.cx + R * Math.cos(angle) - swatchSize / 2) + "px";
    el.style.top = Math.round(center.cy + R * Math.sin(angle) - swatchSize / 2) + "px";
  };

  let i = 0;
  ringPalette.forEach(c => {
    const cell = document.createElement("div");
    cell.className = "swatch-cell ring-cell";
    const b = document.createElement("button");
    b.className = "swatch" + (c === V.colorHex ? " active" : "");
    b.style.background = c;
    b.onclick = () => { setColor(c); closeColorPop(); };
    cell.appendChild(b);
    if (ringPalette.length > PALETTE_MIN) {
      const rm = document.createElement("button");
      rm.textContent = "×"; rm.title = "Remove this color";
      rm.className = "swatch-remove";
      rm.onclick = ev => {
        ev.stopPropagation();
        setPaletteFor(V.tool, ringPalette.filter(x => x !== c));
        refreshPaletteUI();
        buildColorRing(pop, center);
      };
      cell.appendChild(rm);
    }
    place(cell, i); pop.appendChild(cell); i++;
  });

  if (canAdd) {
    // Clicking this opens the OS color picker directly; whatever's picked is added to the
    // palette and made current in one step, rather than picking a color then separately
    // clicking + to add it.
    const addWrap = buildAddColorInput(() => buildColorRing(pop, center));
    addWrap.classList.add("ring-size");
    place(addWrap, i); pop.appendChild(addWrap); i++;
  }

  // A dot exactly where the cursor was, showing the current color, so the ring reads as
  // "options arranged around here" rather than floating disconnected from the click point.
  const centerDot = document.createElement("div");
  centerDot.className = "ring-center";
  centerDot.style.background = V.colorHex;
  centerDot.style.left = Math.round(center.cx) + "px";
  centerDot.style.top = Math.round(center.cy) + "px";
  pop.appendChild(centerDot);
}

function openColorPop() {
  const pop = $("colorPop");
  const R = ringRadius(ringSlotCount());
  const center = computeRingCenter(lastClient.x, lastClient.y, R + RING_SWATCH / 2, innerWidth, innerHeight);
  pop.classList.add("open");
  buildColorRing(pop, center);
  setTimeout(() => addEventListener("pointerdown", pointerdown, true), 0);
}
function pointerdown(e) { if (!$("colorPop").contains(e.target)) closeColorPop(); }
function closeColorPop() {
  $("colorPop").classList.remove("open");
  $("colorPop").innerHTML = "";
  removeEventListener("pointerdown", pointerdown, true);
}

/* File dropdown (Image / PDF in / Export / Save / Open), anchored under the toolbar button that
   opened it — same click-outside-to-close mechanics as the color pop above. */
function toggleFileMenu(btnEl) {
  const menu = $("fileMenu");
  if (menu.classList.contains("open")) { closeFileMenu(); return; }
  const r = btnEl.getBoundingClientRect();
  menu.style.left = Math.round(r.left) + "px";
  menu.style.top = Math.round(r.bottom + 4) + "px";
  menu.classList.add("open");
  setTimeout(() => addEventListener("pointerdown", fileMenuOutside, true), 0);
}
function closeFileMenu() {
  $("fileMenu").classList.remove("open");
  removeEventListener("pointerdown", fileMenuOutside, true);
}
function fileMenuOutside(e) { if (!$("fileMenu").contains(e.target)) closeFileMenu(); }
function wireFileMenu() {
  $("fmImage").onclick = () => { closeFileMenu(); $("fileImg").click(); };
  $("fmPdfIn").onclick = () => { closeFileMenu(); $("filePdf").click(); };
  $("fmExport").onclick = () => { closeFileMenu(); openExportDialog(); };
  $("fmSave").onclick = () => { closeFileMenu(); saveFile(); };
  $("fmOpen").onclick = () => { closeFileMenu(); $("fileOpen").click(); };

  loadPencilOnlyPref();
  const pencilChk = $("fmPencilOnly");
  pencilChk.checked = pencilOnly;
  pencilChk.onchange = () => { pencilOnly = pencilChk.checked; savePencilOnlyPref(); };
}

let remapping = null;
function beginRemap(id, kbdEl) {
  remapping = { id, kbdEl };
  kbdEl.textContent = "press a key…";
  kbdEl.classList.add("listening");
}

/* ---------------- keyboard ---------------- */
addEventListener("keydown", e => {
  // Any open <dialog> (shape importer, confirm, page picker, name prompt…) or an in-place rename
  // in the Files tree owns the keyboard while it's up — without this, typing into e.g. a "New
  // notebook" name field would also fire canvas hotkeys like the digit-key color presets.
  if (editingText || libEditingName || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if (pendingPlacement) {
    if (k === "escape") { pendingPlacement = null; needsDraw = true; e.preventDefault(); }
    return;
  }
  if (remapping) {
    e.preventDefault();
    if (k !== "escape" && !["control", "shift", "alt", "meta"].includes(k)) {
      for (const kk of Object.keys(keymap)) if (keymap[kk] === remapping.id) delete keymap[kk];
      delete keymap[k]; 
      keymap[k] = remapping.id;
      saveKeymap();
    }
    remapping.kbdEl.classList.remove("listening");
    remapping = null;
    rebuildSidebar(); refreshHelp(); buildSelToolbar();
    return;
  }
  const C = e.ctrlKey || e.metaKey;
  const handled = () => { e.preventDefault(); syncUI(); };
  if (C && k === "z") { e.shiftKey ? redo() : undo(); return handled(); }
  if (C && k === "y") { redo(); return handled(); }
  if (C && k === "s") { saveFile(); return handled(); }
  if (C && k === "o") { $("fileOpen").click(); return handled(); }
  if (C && k === "e") { openExportDialog(); return handled(); }
  if (C && k === "d") { duplicateSelection(); return handled(); }
  if (C && k === "c") { copySelectionToClipboard(); return handled(); }
  if (C && k === "v") { pasteFromClipboard(); return handled(); }
  if (C && k === "0") { setZoom(1); return handled(); }
  if (C) return;

  switch (k) { 
    case "1": case "2": case "3": case "4": case "5": case "6": case "7": case "8": case "9": {
      const pal = paletteFor(V.tool);
      if (pal[+k - 1]) setColor(pal[+k - 1]);
      return handled();
    }
    case "pageup": V.scroll -= stride(); clampScroll(); schedulePdfUpgrade(); return handled();
    case "pagedown": V.scroll += stride(); clampScroll(); schedulePdfUpgrade(); return handled();
    case "home": V.scroll = 0; clampScroll(); schedulePdfUpgrade(); return handled();
    case "end": V.scroll = maxScroll(); clampScroll(); schedulePdfUpgrade(); return handled();
    case "f5": toggleRecord(); return handled();
    case " ":
      if (audio.segments.length || audio.rec) { audio.rec ? stopRecord() : togglePlayback(); }
      return handled();
    case "delete": case "backspace":
      if (sel.items.length) deleteSelection();
      else if (confirm("Clear this page?")) clearCurrentPage();
      return handled();
    case "escape": clearSelection(); return handled();
    case "f1": $("helpDlg").showModal(); return handled();
    case "f2": V.sidebar = !V.sidebar; return handled();
    case "f3": togglePopout(); return handled();
    case "f4": V.minimap = !V.minimap; return handled();
  }
  const act = ACTIONS.find(a => a.id === keymap[k]);
  if (act) { act.run(); return handled(); }
});

/* ---------------- status + UI sync ---------------- */
