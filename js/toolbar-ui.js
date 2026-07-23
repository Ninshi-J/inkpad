"use strict";
const ICONS = {
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 13.5l1-3.5 7.5-7.5 2.5 2.5-7.5 7.5-3.5 1z"/><path d="M9.5 4l2.5 2.5"/></svg>',
  hl: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10l6-6 3 3-6 6H3v-3z"/><path d="M2 14.5h12" stroke-opacity=".45" stroke-width="3"/></svg>',
  eraserStroke: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 13L2 9.5 8.5 3l3.5 3.5L7.5 11"/><path d="M5.5 13H14"/></svg>',
  eraserPartial: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5" stroke-dasharray="2.5 2.5"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/></svg>',
  tape: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="12" height="6" rx="1.5"/><path d="M5 5v6" stroke-opacity=".5"/></svg>',
  lasso: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3c3.5 0 6 1.4 6 3.4S11.5 9.8 8 9.8 2 8.4 2 6.4 4.5 3 8 3z" stroke-dasharray="2.6 2"/><path d="M5 9.5c-.8 1.6-.4 3 .8 3.6"/></svg>',
  text: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4V2.8h10V4M8 2.8v10.4M6 13.2h4"/></svg>',
  laser: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="5" r="2"/><path d="M2 14c2.5-2 5-5 7-7.5" stroke-dasharray="2 2"/></svg>',
  ruler: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.8" y="9.2" width="12.4" height="4" rx="1" transform="rotate(-30 8 11)"/><path d="M5 10.5l.8 1.4M7.5 9l.8 1.4M10 7.5l.8 1.4" transform="rotate(0)"/></svg>',
  // Same artwork as the matching tiles inside #shapeImporterDlg (triangle/cube/coordinate-plane),
  // reused here so each toolbar button reads as a preview of what it opens straight to.
  shape2d: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 L21 20 L3 20 Z" stroke-linejoin="round"/></svg>',
  shape3d: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8 L3 19 L14 19 L14 8 Z"/><path d="M3 8 L8 3 L19 3 L14 8 Z"/><path d="M14 8 L19 3 L19 14 L14 19"/></svg>',
  // The full-cross coordinate-plane icon reads as just a "+" at this button's small size — its
  // detail sits right where the axes cross. This is the Quadrant-1 tile's icon instead: axes meet
  // at a corner, leaving the diagonal line room to read clearly as "a graph" even shrunk down.
  graphTools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 21h18M3 21V3"/><path d="M4 18c3-5 6-9 9-12" stroke-width="1.4"/></svg>',
};
const TOOL_LIST = [
  ["pen", "Pen", "pen"], ["hl", "Highlighter", "hl"],
  ["eraserStroke", "Eraser", "eraser"], ["eraserPartial", "Partial eraser", "eraserP"],
  ["tape", "Tape", "tape"], ["lasso", "Lasso", "lasso"],
  ["text", "Text", "text"], ["laser", "Laser", "laser"],
];

function buildToolButtons(host) {
  host.innerHTML = "";
  const gFile = div("tb-group");
  gFile.append(
    btn("File ▾", e => toggleFileMenu(e.currentTarget), "Import image/PDF, export, save, or open"),
  );
  host.appendChild(gFile);
  host.appendChild(sep());

  const gPanel = div("tb-group");
  gPanel.append(
    btn("Panel", () => { V.sidebar = !V.sidebar; syncUI(); }, "Toggle side panel (F2)"),
    btn(V.popped ? "Dock" : "Pop out", togglePopout, "Float the tools (F3)"),
    btn("Overview", () => { V.minimap = !V.minimap; syncUI(); }, "Toggle document overview rail (F4)"),
  );
  host.appendChild(gPanel);
  host.appendChild(sep());

  const g1 = div("tb-group");
  for (const [id, label, actId] of TOOL_LIST) {
    const b = btn(`${ICONS[id]}<span>${label}</span>`, () => setTool(id));
    b.dataset.tool = id;
    b.title = `${label} (${keyFor(actId).toUpperCase()})`;
    g1.appendChild(b);
  }
  const ruler = btn(`${ICONS.ruler}<span>Ruler</span>`, () => { V.ruler = !V.ruler; syncUI(); });
  ruler.id = "rulerBtn"; ruler.title = `Straight lines (${keyFor("ruler").toUpperCase()}) — hold Shift while drawing for a straight line snapped to horizontal/vertical, with or without this on`;
  g1.appendChild(ruler);
  host.appendChild(g1);
  host.appendChild(sep());

  const g2 = div("tb-group");
  const tbPalette = paletteFor(V.tool);
  tbPalette.forEach((c, i) => {
    const s = document.createElement("button");
    s.className = "swatch"; s.style.background = c; s.title = `Color ${i + 1}`;
    s.onclick = () => { setColor(c); };
    s.dataset.colorhex = c;
    g2.appendChild(s);
  });
  if (tbPalette.length < PALETTE_MAX) {
    const addWrap = buildAddColorInput();
    addWrap.classList.add("tb-size");
    g2.appendChild(addWrap);
  }
  host.appendChild(g2);
  host.appendChild(sep());

  const g3 = div("tb-group"); g3.id = "widthWrap";
  const dot = document.createElement("span"); dot.id = "widthDot";
  const rng = document.createElement("input");
  rng.type = "range"; rng.min = 0; rng.max = PEN_SLIDER_STEPS; rng.value = widthToSliderPos(V.width);
  rng.title = `Pen width: ${V.width}px ( [ ] )`;
  rng.oninput = () => { V.width = sliderPosToWidth(+rng.value); syncUI(); };
  rng.id = "widthRange";
  g3.append(dot, rng);
  host.appendChild(g3);
  host.appendChild(sep());

  const g5 = div("tb-group");
  const recB = btn("● Rec", toggleRecord, "Record audio (F5)"); recB.id = host === TB ? "recBtn" : "recBtn2";
  const playB = btn("▶", togglePlayback, "Play / pause note replay (Space)"); playB.id = host === TB ? "playBtn" : "playBtn2";
  g5.append(recB, playB);
  host.appendChild(g5);
  host.appendChild(sep());

  const g6 = div("tb-group");
  g6.append(
    btn("−", () => setZoom(V.zoom / 1.15), "Zoom out"),
    btn("+", () => setZoom(V.zoom * 1.15), "Zoom in"),
  );
  host.appendChild(g6);
  host.appendChild(sep());

  const gClassroom = div("tb-group");
  gClassroom.append(
    btn("🎲 Random", openRandomDlg, `Random student picker, dice roller, and number spinner (${keyFor("random").toUpperCase()})`),
    btn("⏱ Timer", toggleTimerWidget, `Timer / stopwatch overlay (${keyFor("timer").toUpperCase()})`),
  );
  host.appendChild(gClassroom);
  host.appendChild(sep());

  const gImporter = div("tb-group");
  gImporter.style.marginLeft = "auto";
  gImporter.append(
    btn(ICONS.shape2d, () => openShapeDialog("2d"), "2D Shapes — triangles, circles, polygons, and more"),
    btn(ICONS.shape3d, () => openShapeDialog("3d"), "3D Shapes — cubes, prisms, cylinders, cones, pyramids"),
    btn(ICONS.graphTools, () => openShapeDialog("tools"), "Graphing Tools — coordinate planes and number lines"),
    btn("🏷️ Stamps", openStampDlg, "Reusable stamps — save a selection once, insert it again on any page"),
  );
  host.appendChild(gImporter);
}
const div = c => { const d = document.createElement("div"); d.className = c; return d; };
const sep = () => div("tb-sep");
function btn(html, fn, title) {
  const b = document.createElement("button");
  b.className = "tb"; b.innerHTML = html; b.onclick = fn;
  if (title) b.title = title;
  return b;
}
function setTool(t) {
  if (drag) return; 
  if (t !== V.tool) V.prevTool = V.tool;
  V.tool = t;
  if (t === "pen" || t === "hl" || t === "text") {
    V.lastColorTool = t;
    V.colorHex = V.colorByTool[t] ?? V.colorHex; 
  }
  if (t !== "lasso") clearSelection();
  if (t !== "text") commitTextEdit();
  cv.style.cursor = t.startsWith("eraser") ? "none" : t === "lasso" ? "default" : "crosshair";
  buildToolButtons(V.popped ? PALB : TB); // swatches shown depend on the tool (highlighter has its own palette)
  syncUI();
}
function swapTool() { setTool(V.prevTool); }
function togglePopout() {
  V.popped = !V.popped;
  TB.classList.toggle("popped", V.popped);
  PAL.classList.toggle("open", V.popped);
  buildToolButtons(V.popped ? PALB : TB);
  syncUI(); resize();
}

(() => {
  let sx0 = 0, sy0 = 0, ox = 0, oy = 0, on = false;
  $("paletteHandle").addEventListener("pointerdown", e => {
    on = true; sx0 = e.clientX; sy0 = e.clientY;
    const r = PAL.getBoundingClientRect(); ox = r.left; oy = r.top;
    $("paletteHandle").setPointerCapture(e.pointerId);
  });
  $("paletteHandle").addEventListener("pointermove", e => {
    if (!on) return;
    PAL.style.left = Math.max(4, ox + e.clientX - sx0) + "px";
    PAL.style.top = Math.max(4, oy + e.clientY - sy0) + "px";
  });
  $("paletteHandle").addEventListener("pointerup", () => on = false);
})();

/* ---------------- sidebar ---------------- */
// Collapsible sidebar sections remember their open/closed state across reloads.
