"use strict";
const QUAD_TYPES = ["square", "rectangle", "parallelogram"];
function toggleShapeFormFields() {
  const type = $("shapeTypeSelect").value;
  $("planeFields").style.display = type === "plane" ? "block" : "none";
  $("planeMathFields").style.display = type === "planeMath" ? "block" : "none";
  $("planeQ1Fields").style.display = type === "planeQ1" ? "block" : "none";
  $("triangleFields").style.display = type === "triangle" ? "block" : "none";
  $("circleFields").style.display = type === "circle" ? "block" : "none";
  $("quadFields").style.display = QUAD_TYPES.includes(type) ? "block" : "none";
  $("quadSquareFields").style.display = type === "square" ? "block" : "none";
  $("quadRectFields").style.display = type === "rectangle" ? "block" : "none";
  $("quadParaFields").style.display = type === "parallelogram" ? "block" : "none";
  $("polygonFields").style.display = type === "polygon" ? "block" : "none";
  const SOLID3D_TYPES = ["cube", "prism", "cylinder", "cone", "pyramid"];
  $("solid3dFields").style.display = SOLID3D_TYPES.includes(type) ? "block" : "none";
  $("cubeFields").style.display = type === "cube" ? "block" : "none";
  $("prismFields").style.display = type === "prism" ? "block" : "none";
  $("cylinderFields").style.display = type === "cylinder" ? "block" : "none";
  $("coneFields").style.display = type === "cone" ? "block" : "none";
  $("pyramidFields").style.display = type === "pyramid" ? "block" : "none";
  $("solid3dDepthAngleField").style.display = ["cube", "prism", "pyramid"].includes(type) ? "block" : "none";
  $("solid3dPerspectiveField").style.display = ["cylinder", "cone"].includes(type) ? "block" : "none";
  $("numberlineFields").style.display = type === "numberline" ? "block" : "none";
  $("fractionFields").style.display = type === "fraction" ? "block" : "none";
  $("spinnerFields").style.display = type === "spinner" ? "block" : "none";
  $("vennFields").style.display = type === "venn" ? "block" : "none";
  $("tableFields").style.display = type === "table" ? "block" : "none";
  $("treeFields").style.display = type === "tree" ? "block" : "none";
  $("stemleafFields").style.display = type === "stemleaf" ? "block" : "none";
  $("histogramFields").style.display = type === "histogram" ? "block" : "none";
  $("boxplotFields").style.display = type === "boxplot" ? "block" : "none";
  // Class start/width only mean anything while the bars are numbered, not named.
  if (type === "histogram") $("hgClassFields").style.display = $("hgLabels").value.trim() ? "none" : "";
  // A third circle brings three more regions with it — hidden rather than disabled so the
  // two-set form stays as short as it was.
  if (type === "venn") {
    const three = $("vnSets").value === "3";
    document.querySelectorAll("#vennFields .venn-3only").forEach(el => {
      // The region checkboxes are inline labels inside a grid; the field rows are blocks.
      el.style.display = three ? (el.tagName === "LABEL" ? "flex" : "") : "none";
    });
  }
}

const SHAPE_CATEGORY = {
  triangle: "2d", circle: "2d", square: "2d", rectangle: "2d", parallelogram: "2d",
  polygon: "2d", fraction: "2d",
  cube: "3d", prism: "3d", cylinder: "3d", cone: "3d", pyramid: "3d",
  plane: "tools", planeMath: "tools", planeQ1: "tools", numberline: "tools",
  spinner: "data", venn: "data", table: "data", tree: "data",
  stemleaf: "data", histogram: "data", boxplot: "data",
};
// Which generator builds each probability/data diagram (js/shape-prob.js). Keyed rather than
// branched so buildMathShapeSVG's if-chain doesn't grow another four arms.
const PROB_SHAPE_BUILDERS = {
  spinner: () => buildSpinnerSvg(), venn: () => buildVennSvg(),
  table: () => buildTableSvg(), tree: () => buildTreeSvg(),
  stemleaf: () => buildStemLeafSvg(), histogram: () => buildHistogramSvg(),
  boxplot: () => buildBoxPlotSvg(),
};
function selectShapeCategory(category) {
  document.querySelectorAll("#shapeTypeTiles .shape-tile").forEach(t => {
    t.style.display = t.dataset.category === category ? "" : "none";
  });
  localStorage.setItem("inkpad.shapeCategory", category);
  scheduleSettingsSave();
}
function selectShapeType(type) {
  $("shapeTypeSelect").value = type;
  document.querySelectorAll("#shapeTypeTiles .shape-tile").forEach(t => t.classList.toggle("active", t.dataset.type === type));
  selectShapeCategory(SHAPE_CATEGORY[type] || "2d");
  toggleShapeFormFields();
  renderShapePreview();
}
const SHAPE_CATEGORY_DEFAULT = { "2d": "triangle", "3d": "cube", tools: "plane", data: "spinner" };
// Opens the shape-importer dialog straight to one of its three category tabs — used by the
// toolbar's three shape buttons (2D/3D/Graphing Tools) instead of one generic "Diagrams" button.
// Keeps whatever type was last selected if it already belongs to that category (so re-opening the
// same tab picks up where you left off), otherwise falls back to that category's first shape.
function openShapeDialog(category) {
  editingShapeTarget = null; // fresh "insert new shape" flow, not editing a placed one
  $("insertShapeBtn").textContent = "Insert Shape";
  $("shapeImporterDlg").showModal();
  applyShapePrefsToDialog();
  applyShapeDefaultsToImporter();
  const current = $("shapeTypeSelect").value;
  selectShapeType(SHAPE_CATEGORY[current] === category ? current : SHAPE_CATEGORY_DEFAULT[category]);
}

/* ---------------- editing an already-placed graph ----------------
   Only the three coordinate-plane graph tools (plane, planeMath, planeQ1) support this — they're
   the only shapes placed as a single self-contained image with no separate auto-generated text
   labels (see labelSpecs elsewhere in this file): every other shape type (triangle, solids, the
   fraction tool, ...) drops independent, freely movable/editable doc.texts alongside the image,
   and once placed there's no reliable way to tell which of those the user has since repositioned
   or hand-edited — regenerating could silently discard or duplicate that work. A plain graph image
   has no such ambiguity, so re-editing it is just "swap the image, same spot, same size." */
const SHAPE_GEN_FIELD_CONTAINERS = {
  plane: "planeFields", planeMath: "planeMathFields", planeQ1: "planeQ1Fields",
  // The probability diagrams qualify for the same reason the graphs do: they place as one
  // self-contained image with no separate auto-generated text objects, so regenerating one can't
  // orphan or duplicate anything the user has since moved.
  spinner: "spinnerFields", venn: "vennFields", table: "tableFields", tree: "treeFields",
  stemleaf: "stemleafFields", histogram: "histogramFields", boxplot: "boxplotFields",
};
const SHAPE_GEN_FN_LIST_IDS = { planeMath: "pmFnList", planeQ1: "q1FnList" };
let editingShapeTarget = null; // the doc.images ref currently being re-edited, or null for a fresh insert
// Snapshots every field inside the current graph type's own fields container (plus its dynamic
// function-list rows, for planeMath/planeQ1) so the dialog can be reopened pre-filled later.
// Returns null for any non-graph shape type — those aren't re-editable (see comment above).
function captureShapeGenParams() {
  const type = $("shapeTypeSelect").value;
  const containerId = SHAPE_GEN_FIELD_CONTAINERS[type];
  if (!containerId) return null;
  const fields = {};
  $(containerId).querySelectorAll("input[id], select[id], textarea[id]").forEach(el => {
    fields[el.id] = el.type === "checkbox" ? el.checked : el.value;
  });
  const listId = SHAPE_GEN_FN_LIST_IDS[type] || null;
  const fnRows = listId ? Array.from($(listId).querySelectorAll(".eq-row")).map(row => ({
    expr: row.querySelector(".eq-expr").value,
    label: row.querySelector(".eq-label").value,
    enabled: row.querySelector(".eq-enabled").checked,
  })) : [];
  return { type, fields, listId, fnRows };
}
// Inverse of captureShapeGenParams() — pre-fills the dialog from a previously-saved snapshot.
function applyShapeGenParams(gen) {
  if (!gen) return;
  selectShapeType(gen.type);
  for (const [id, val] of Object.entries(gen.fields)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!val; else el.value = val;
  }
  if (gen.listId) {
    $(gen.listId).innerHTML = "";
    gen.fnRows.forEach(r => addEqRow(gen.listId, r.expr, r.label, r.enabled));
  }
  // Re-derive fields' own disabled/enabled visual state (normally an onchange side effect of
  // the checkbox that gates them) since setting .checked directly above doesn't fire it.
  if (gen.type === "planeMath") toggleAxisLabelInputs("pmLabelAxes", "pmAxisXLabel", "pmAxisYLabel");
  if (gen.type === "planeQ1") toggleAxisLabelInputs("q1LabelAxes", "q1AxisXLabel", "q1AxisYLabel");
  // selectShapeType() above ran before vnSets was restored, so the third circle's fields were
  // shown or hidden against the wrong value — settle them now the form is actually filled in.
  if (gen.type === "venn") toggleShapeFormFields();
  renderShapePreview();
}
// Opens the importer pre-filled with the graph's own generating values (stored on the image at
// placement time — see finalizePendingPlacement in images.js). Regenerating replaces this same
// image in place instead of starting a new click-to-place — see generateAndInsertMathShape().
function editGeneratedShape(im) {
  if (!im.shapeGen) return;
  editingShapeTarget = im;
  $("shapeImporterDlg").showModal();
  applyShapeGenParams(im.shapeGen);
  $("insertShapeBtn").textContent = "Update Graph";
}
// However the dialog closes (Cancel, Escape, backdrop click, or a real generate), the "editing a
// placed shape" state shouldn't survive past it — generateAndInsertMathShape() below captures
// editingShapeTarget into a local before calling .close(), so this firing mid-generate is safe.
$("shapeImporterDlg").addEventListener("close", () => { editingShapeTarget = null; });
// Swaps an already-placed graph's rendered image (and its regenerable params) in place — same
// x/y/w/h, same rot/flip, nothing else on the page touched. Mirrors clearShapeFromImage's pattern
// of mutating the existing doc.images ref's img/data in place rather than replacing the object,
// so the current selection and any other reference to it stay valid across the edit.
function replaceGeneratedShape(im, svgString, genParams) {
  const dataUrl = SHAPE_SVG_URL_PREFIX + encodeURIComponent(svgString);
  const img = new Image();
  const before = { data: im.data, img: im.img, shapeGen: im.shapeGen };
  img.onload = () => {
    im.data = dataUrl; im.img = img; im.shapeGen = genParams;
    pushUndo({ op: "replaceShape", ref: im, before, after: { data: dataUrl, img, shapeGen: genParams } });
    markDirty(); needsDraw = true; mmCache.clear();
  };
  setShapeImgSrc(img, dataUrl); // fonts are spliced into the <img> only, never the stored data
}

/* ---------------- shape/graph defaults (device/user-level, like the keymap — not tied to any
   one notebook) — the placed size fraction, plus each graph tool's starting font size and grid
   thickness. Persisted in localStorage and mirrored into the same settings snapshot as
   keymap/palette/text defaults (see currentSettingsSnapshot/applySettingsSnapshot in storage.js),
   so it follows a teacher between devices the same way those already do. */
/* How big a placed shape is, as a fraction of the page width/height it has to fit inside.

   Three classes, because one number cannot serve all of them. A triangle is compact and mostly
   line work, so a quarter of the page is generous. A coordinate plane is square and carries axis
   numbers. A data chart is wide, short and almost entirely text — and the fraction applies to the
   WIDTH, so the wider the picture the smaller its text ends up. Measured on A4 portrait at the old
   shared 31%: a histogram's axis numbers landed at 8px and a box plot's at 7.8px, against body
   text of 16-20px. 55% brings those to roughly 14px, which is the point of the separate class. */
const SHAPE_SIZE_CLASS = {
  plane: "graph", planeMath: "graph", planeQ1: "graph",
  spinner: "chart", venn: "chart", table: "chart", tree: "chart",
  stemleaf: "chart", histogram: "chart", boxplot: "chart",
  // The number line predates the split and was taking the compact "shape" figure despite being
  // 500 units wide and nothing but tick labels — they were landing at 7.9px.
  numberline: "chart",
};
function shapeSizeFracFor(type, srcBox) {
  const cls = SHAPE_SIZE_CLASS[type] || (srcBox ? "shape" : "graph");
  if (cls === "chart") return shapeDefaults.chartSizeFrac;
  return cls === "graph" ? shapeDefaults.graphSizeFrac : shapeDefaults.shapeSizeFrac;
}
const SHAPE_DEFAULTS_FALLBACK = {
  graphFontSize: 20, graphGridThickness: 2, tickFormat: "auto",
  graphSizeFrac: 0.3125, shapeSizeFrac: 0.25, chartSizeFrac: 0.55,
};
let shapeDefaults = { ...SHAPE_DEFAULTS_FALLBACK };
function loadShapeDefaults() {
  shapeDefaults = { ...SHAPE_DEFAULTS_FALLBACK };
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.shapeDefaults") || "null");
    if (j && typeof j === "object") Object.assign(shapeDefaults, j);
  } catch (_) {}
}
function saveShapeDefaults() {
  try { localStorage.setItem("inkpad.shapeDefaults", JSON.stringify(shapeDefaults)); } catch (_) {}
  scheduleSettingsSave();
}
// Pre-fills each of the three graph tools' own font-size/grid-thickness fields with the saved
// defaults — called once per dialog open, same timing as applyShapePrefsToDialog(). Only those
// two fields are seeded this way (the axis min/max/step ranges are per-diagram content, not a
// "default" a teacher would want to reuse across unrelated graphs).
function applyShapeDefaultsToImporter() {
  for (const prefix of ["plane", "pm", "q1"]) {
    const fontEl = $(`${prefix}FontSize`), gridEl = $(`${prefix}GridThickness`);
    // Both are number boxes now, so they show their own value — no separate readout to keep in step.
    if (fontEl) fontEl.value = shapeDefaults.graphFontSize;
    if (gridEl) gridEl.value = shapeDefaults.graphGridThickness;
    // Tick number format is seeded the same way rather than being a per-diagram field: a teacher
    // who works to 2 significant figures wants that on every graph, not re-picked each time.
    const fmtEl = $(`${prefix}TickFmt`);
    if (fmtEl) fmtEl.value = shapeDefaults.tickFormat || "auto";
  }
}
// Changing the format in any graph tool makes it the starting point for the next graph too.
// (Re-editing a placed graph still restores that graph's own saved format — applyShapeGenParams
// runs after this seeding, so the snapshot wins.)
function setGraphTickFmtDefault(v) {
  shapeDefaults.tickFormat = v;
  saveShapeDefaults();
}
// Populates/commits the "Shapes & Graphs" category's fields inside the unified #settingsDlg
// (js/settings-ui.js) — these two used to open/save a dedicated #shapeDefaultsDlg, folded into
// that dialog as just another category since this session's settings-consolidation feature.
function populateShapeDefaultsFields() {
  $("sdGraphFontSize").value = shapeDefaults.graphFontSize; $("sdGraphFontVal").textContent = shapeDefaults.graphFontSize;
  $("sdGraphGridThickness").value = shapeDefaults.graphGridThickness; $("sdGraphGridVal").textContent = shapeDefaults.graphGridThickness;
  $("sdGraphSizeFrac").value = Math.round(shapeDefaults.graphSizeFrac * 100);
  $("sdShapeSizeFrac").value = Math.round(shapeDefaults.shapeSizeFrac * 100);
  $("sdChartSizeFrac").value = Math.round(shapeDefaults.chartSizeFrac * 100);
}
function resetShapeDefaultsFields() {
  $("sdGraphFontSize").value = SHAPE_DEFAULTS_FALLBACK.graphFontSize; $("sdGraphFontVal").textContent = SHAPE_DEFAULTS_FALLBACK.graphFontSize;
  $("sdGraphGridThickness").value = SHAPE_DEFAULTS_FALLBACK.graphGridThickness; $("sdGraphGridVal").textContent = SHAPE_DEFAULTS_FALLBACK.graphGridThickness;
  $("sdGraphSizeFrac").value = Math.round(SHAPE_DEFAULTS_FALLBACK.graphSizeFrac * 100);
  $("sdShapeSizeFrac").value = Math.round(SHAPE_DEFAULTS_FALLBACK.shapeSizeFrac * 100);
  $("sdChartSizeFrac").value = Math.round(SHAPE_DEFAULTS_FALLBACK.chartSizeFrac * 100);
}
/* One typed percentage from the settings dialog. Clamped rather than validated-and-rejected: the
   field is free text now (it used to be a 15-50 slider, which is exactly the constraint being
   removed), so 5 is allowed for a thumbnail and 100 for a full-page chart, and anything outside
   that or unreadable falls back to the built-in default instead of producing a zero-size shape. */
function shapeSizePctField(id, fallbackFrac) {
  const pct = parseFloat($(id).value);
  if (!Number.isFinite(pct) || pct <= 0) return fallbackFrac;
  return Math.min(100, Math.max(5, pct)) / 100;
}
function commitShapeDefaultsFromSettingsDlg() {
  // Spread first: this dialog only edits four of the defaults, and rebuilding the object from
  // just its own fields would silently drop any the dialog doesn't show (e.g. tickFormat).
  shapeDefaults = {
    ...shapeDefaults,
    graphFontSize: parseInt($("sdGraphFontSize").value) || SHAPE_DEFAULTS_FALLBACK.graphFontSize,
    graphGridThickness: parseFloat($("sdGraphGridThickness").value) || SHAPE_DEFAULTS_FALLBACK.graphGridThickness,
    graphSizeFrac: shapeSizePctField("sdGraphSizeFrac", SHAPE_DEFAULTS_FALLBACK.graphSizeFrac),
    shapeSizeFrac: shapeSizePctField("sdShapeSizeFrac", SHAPE_DEFAULTS_FALLBACK.shapeSizeFrac),
    chartSizeFrac: shapeSizePctField("sdChartSizeFrac", SHAPE_DEFAULTS_FALLBACK.chartSizeFrac),
  };
  saveShapeDefaults();
  applyShapeDefaultsToImporter();
  renderShapePreview();
}

// Per-notebook shape-dialog checkbox prefs (e.g. "show side labels") — saved in
// S.shapePrefs, which rides along with everything else serialized per notebook.
// A checkbox's own HTML "checked" attribute (.defaultChecked) is the fallback
// for a notebook that's never touched this particular checkbox before.
function applyShapePrefsToDialog() {
  document.querySelectorAll('#shapeImporterDlg input[type="checkbox"]').forEach(cb => {
    cb.checked = S.shapePrefs && Object.prototype.hasOwnProperty.call(S.shapePrefs, cb.id) ? S.shapePrefs[cb.id] : cb.defaultChecked;
  });
}
function captureShapePrefsFromDialog() {
  document.querySelectorAll('#shapeImporterDlg input[type="checkbox"]').forEach(cb => { S.shapePrefs[cb.id] = cb.checked; });
  markDirty(); invalidateCleanMarker(); // not undo-tracked
}

function handleDlgRightAngleToggle() {
  const isRight = $("triRightAngle").checked;
  $("triAngleA").disabled = isRight;
  if (isRight) $("triAngleA").value = "";
  renderShapePreview();
}

function randomiseTriangleFields() {
  const isRight = $("triRightAngle").checked;
  const targetSide = $("triGenTarget").value === "side";
  
  $("triTickBottom").checked = false;
  $("triTickLeft").checked = false;
  $("triTickRight").checked = false;
  $("triRotation").value = Math.floor(Math.random() * 361); // shown on the shape, not in a field

  if (isRight) {
    const angle = Math.floor(Math.random() * 35) + 25;
    $("triAngleA").value = "";
    
    if (targetSide) {
      const angleChoice = Math.random() > 0.5;
      $("triAngleB").value = angleChoice ? (90 - angle) + "°" : "";
      $("triAngleC").value = angleChoice ? "" : angle + "°";
      
      const sideCombo = Math.floor(Math.random() * 4);
      const hyp = Math.floor(Math.random() * 10) + 10;
      if (sideCombo === 0) {
        // leg (left) unknown, hypotenuse given -> sin/cos
        $("triBottom").value = "";
        $("triLeft").value = "x";
        $("triRight").value = hyp;
      } else if (sideCombo === 1) {
        // leg (bottom) unknown, hypotenuse given -> sin/cos
        $("triBottom").value = "x";
        $("triLeft").value = "";
        $("triRight").value = hyp;
      } else if (sideCombo === 2) {
        // hypotenuse unknown, one leg given -> sin/cos
        $("triBottom").value = Math.floor(Math.random() * 6) + 5;
        $("triLeft").value = "";
        $("triRight").value = "x";
      } else {
        // both legs involved, hypotenuse hidden entirely -> tan
        const knownLeft = Math.random() > 0.5;
        const legVal = Math.floor(Math.random() * 10) + 5;
        $("triRight").value = "";
        $("triLeft").value = knownLeft ? legVal : "x";
        $("triBottom").value = knownLeft ? "x" : legVal;
      }
    } else {
      const angleChoice = Math.random() > 0.5;
      $("triAngleB").value = angleChoice ? "θ" : "";
      $("triAngleC").value = angleChoice ? "" : "θ";
      $("triBottom").value = Math.floor(Math.random() * 5) + 3;
      $("triLeft").value = Math.floor(Math.random() * 5) + 4;
      $("triRight").value = "";
    }
  } else {
    const tX = Math.floor(Math.random() * 140) + 180;
    const tY = Math.floor(Math.random() * 80) + 80;
    $("triVertexBX").value = tX;
    $("triVertexBY").value = tY;
    
    const degA = Math.floor(Math.random() * 30) + 40;
    const degC = Math.floor(Math.random() * 30) + 40;
    
    if (targetSide) {
      $("triAngleA").value = degA + "°";
      $("triAngleB").value = "";
      $("triAngleC").value = degC + "°";
      
      const sideCombo = Math.floor(Math.random() * 3);
      if (sideCombo === 0) {
        $("triBottom").value = Math.floor(Math.random() * 10) + 10;
        $("triLeft").value = "x";
        $("triRight").value = "";
      } else if (sideCombo === 1) {
        $("triBottom").value = "x";
        $("triLeft").value = Math.floor(Math.random() * 10) + 10;
        $("triRight").value = "";
      } else {
        $("triBottom").value = "";
        $("triLeft").value = Math.floor(Math.random() * 10) + 10;
        $("triRight").value = "x";
      }
    } else {
      $("triAngleA").value = "θ";
      $("triAngleB").value = "";
      $("triAngleC").value = degC + "°";
      $("triBottom").value = Math.floor(Math.random() * 8) + 8;
      $("triLeft").value = "";
      $("triRight").value = Math.floor(Math.random() * 8) + 7;
    }
  }
  renderShapePreview();
}

function randomiseCircleFields() {
  const r = Math.floor(Math.random() * 8) + 3;
  $("circRadius").value = r;
  $("circShowDiameter").checked = Math.random() > 0.5;
  $("circDiameter").value = r * 2;
  const hasSector = Math.random() > 0.4;
  $("circSectorAngle").value = hasSector ? Math.floor(Math.random() * 120) + 30 : 0;
  $("circSectorLabel").value = hasSector ? (Math.random() > 0.5 ? "θ" : (Math.floor(Math.random() * 90) + 20) + "°") : "";
  renderShapePreview();
}

function randomiseSquareFields() {
  $("quadSquareSide").value = Math.floor(Math.random() * 9) + 3;
  $("quadSquareTicks").checked = Math.random() > 0.3;
  $("quadSquareRight").checked = Math.random() > 0.2;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomiseRectangleFields() {
  const w = Math.floor(Math.random() * 8) + 6;
  let h = Math.floor(Math.random() * 6) + 3;
  if (h === w) h += 2;
  $("quadRectWidth").value = w;
  $("quadRectHeight").value = h;
  $("quadRectRight").checked = Math.random() > 0.2;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomiseParallelogramFields() {
  $("quadParaBase").value = Math.floor(Math.random() * 8) + 6;
  $("quadParaSide").value = Math.floor(Math.random() * 6) + 4;
  $("quadParaAngle").value = Math.floor(Math.random() * 60) + 50;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomisePolygonFields() {
  $("polygonSides").value = Math.floor(Math.random() * 6) + 5;
  $("polygonSide").value = Math.floor(Math.random() * 8) + 3;
  $("polygonShowAngle").checked = Math.random() > 0.25;
  $("polygonRotation").value = Math.floor(Math.random() * 360);
  $("polygonRotVal").textContent = $("polygonRotation").value;
  renderShapePreview();
}

function randomiseCubeFields() {
  $("cubeSide").value = Math.floor(Math.random() * 8) + 3;
  renderShapePreview();
}

function randomisePrismFields() {
  $("prismWidth").value = Math.floor(Math.random() * 8) + 5;
  $("prismHeight").value = Math.floor(Math.random() * 6) + 3;
  $("prismDepth").value = Math.floor(Math.random() * 6) + 3;
  renderShapePreview();
}

function randomiseCylinderFields() {
  const r = Math.floor(Math.random() * 5) + 2;
  $("cylRadius").value = r;
  $("cylHeight").value = Math.floor(Math.random() * 8) + 5;
  const showD = Math.random() > 0.5;
  $("cylShowDiameter").checked = showD;
  $("cylDiameter").value = r * 2;
  renderShapePreview();
}

function randomiseConeFields() {
  $("coneRadius").value = Math.floor(Math.random() * 5) + 2;
  $("coneHeight").value = Math.floor(Math.random() * 8) + 5;
  const showSlant = Math.random() > 0.4;
  $("coneShowSlant").checked = showSlant;
  if (showSlant) {
    const r = +$("coneRadius").value, h = +$("coneHeight").value;
    $("coneSlant").value = Math.round(Math.sqrt(r * r + h * h) * 10) / 10;
  }
  renderShapePreview();
}

function randomisePyramidFields() {
  const sameBase = Math.random() > 0.5;
  const w = Math.floor(Math.random() * 6) + 4;
  $("pyramidWidth").value = w;
  $("pyramidDepth").value = sameBase ? w : Math.floor(Math.random() * 6) + 4;
  $("pyramidHeight").value = Math.floor(Math.random() * 8) + 4;
  renderShapePreview();
}

function randomiseNumberlineFields() {
  const min = -(Math.floor(Math.random() * 8) + 2);
  const max = Math.floor(Math.random() * 8) + 2;
  $("nlMin").value = min; $("nlMax").value = max;
  $("nlStep").value = 1;
  const hasHl = Math.random() > 0.35;
  if (hasHl) {
    const a = Math.floor(Math.random() * (max - min - 1)) + min + 1;
    const openEnded = Math.random() > 0.5;
    if (openEnded) {
      // Showcase the "extend to arrow" mode, e.g. x > a or x < a.
      const dir = Math.random() > 0.5;
      $("nlHlFrom").value = dir ? a : "";
      $("nlHlTo").value = dir ? "" : a;
      $("nlFromCircle").value = dir ? (Math.random() > 0.5 ? "open" : "closed") : "end";
      $("nlToCircle").value = dir ? "end" : (Math.random() > 0.5 ? "open" : "closed");
    } else {
      const dir = Math.random() > 0.5;
      $("nlHlFrom").value = dir ? a : min;
      $("nlHlTo").value = dir ? max : a;
      $("nlFromCircle").value = Math.random() > 0.5 ? "open" : "closed";
      $("nlToCircle").value = Math.random() > 0.5 ? "open" : "closed";
    }
  } else {
    $("nlHlFrom").value = ""; $("nlHlTo").value = "";
    $("nlFromCircle").value = "closed"; $("nlToCircle").value = "closed";
  }
  renderShapePreview();
}

function randomiseFractionFields() {
  $("fracStyle").value = Math.random() > 0.5 ? "bar" : "circle";
  const den = Math.floor(Math.random() * 6) + 3;
  const num = Math.floor(Math.random() * den);
  $("fracDenominator").value = den;
  $("fracNumerator").value = num;
  renderShapePreview();
}

function rotatePoint(pt, center, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    x: cos * (pt.x - center.x) - sin * (pt.y - center.y) + center.x,
    y: sin * (pt.x - center.x) + cos * (pt.y - center.y) + center.y
  };
}

function getBisectorVector(pAnchor, p1, p2, offsetDist, centerPoint) {
  let d1 = { x: p1.x - pAnchor.x, y: p1.y - pAnchor.y };
  let d2 = { x: p2.x - pAnchor.x, y: p2.y - pAnchor.y };
  let len1 = Math.sqrt(d1.x*d1.x + d1.y*d1.y) || 1;
  let len2 = Math.sqrt(d2.x*d2.x + d2.y*d2.y) || 1;
  let u1 = { x: d1.x / len1, y: d1.y / len1 };
  let u2 = { x: d2.x / len2, y: d2.y / len2 };
  let bi = { x: u1.x + u2.x, y: u1.y + u2.y };
  let lenBi = Math.sqrt(bi.x*bi.x + bi.y*bi.y);
  if (lenBi === 0) return { x: pAnchor.x, y: pAnchor.y };
  let bx = bi.x / lenBi, by = bi.y / lenBi;
  let targetVectorX = centerPoint.x - pAnchor.x;
  let targetVectorY = centerPoint.y - pAnchor.y;
  if (bx * targetVectorX + by * targetVectorY < 0) { bx = -bx; by = -by; }
  let dotProd = u1.x * u2.x + u1.y * u2.y;
  let angleRad = Math.acos(Math.max(-1, Math.min(1, dotProd)));
  let extraPush = angleRad < 0.8 ? (0.8 - angleRad) * 26 : 0;
  return {
    x: pAnchor.x + bx * (offsetDist + extraPush + 6),
    y: pAnchor.y + by * (offsetDist + extraPush + 6) + 4
  };
}

function drawAngleArc(pAnchor, p1, p2, radius, centerPoint) {
  let d1 = { x: p1.x - pAnchor.x, y: p1.y - pAnchor.y };
  let d2 = { x: p2.x - pAnchor.x, y: p2.y - pAnchor.y };
  let len1 = Math.sqrt(d1.x*d1.x + d1.y*d1.y) || 1;
  let len2 = Math.sqrt(d2.x*d2.x + d2.y*d2.y) || 1;
  let u1 = { x: d1.x / len1, y: d1.y / len1 };
  let u2 = { x: d2.x / len2, y: d2.y / len2 };
  let arcStart = { x: pAnchor.x + u1.x * radius, y: pAnchor.y + u1.y * radius };
  let arcEnd = { x: pAnchor.x + u2.x * radius, y: pAnchor.y + u2.y * radius };
  let cross = u1.x * u2.y - u1.y * u2.x;
  let midArc = { x: (arcStart.x + arcEnd.x)/2, y: (arcStart.y + arcEnd.y)/2 };
  let dotCheck = (midArc.x - pAnchor.x) * (centerPoint.x - pAnchor.x) + (midArc.y - pAnchor.y) * (centerPoint.y - pAnchor.y);
  let sweepFlag = cross > 0 ? 1 : 0;
  if (dotCheck < 0) sweepFlag = sweepFlag === 1 ? 0 : 1;
  return `  <path d="M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${arcEnd.x} ${arcEnd.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
}

function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Compiles a Typst-style math expression of `x` (e.g. "sin(x)", "x^2 - 3", "2cos(x)+1")
// into a JS function (x) => number. Throws with a descriptive message on invalid syntax.
function compileExpr(src) {
  const s = src.trim();
  if (!s) throw new Error("empty expression");
  let i = 0;
  const peek = () => s[i];
  const isDigit = c => c >= "0" && c <= "9";
  const isAlpha = c => !!c && /[a-zA-Z_]/.test(c);
  const skipWs = () => { while (s[i] === " " || s[i] === "\t") i++; };

  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log: Math.log10, floor: Math.floor,
    ceil: Math.ceil, round: Math.round,
  };

  function canStartPrimary() {
    skipWs();
    const c = peek();
    return c === "(" || isDigit(c) || c === "." || isAlpha(c);
  }
  function parseExpr() { return parseAddSub(); }
  function parseAddSub() {
    let node = parseMulDiv();
    for (;;) {
      skipWs();
      const c = peek();
      if (c === "+" || c === "-") {
        i++;
        const rhs = parseMulDiv(), left = node;
        node = x => c === "+" ? left(x) + rhs(x) : left(x) - rhs(x);
      } else break;
    }
    return node;
  }
  function parseMulDiv() {
    let node = parseUnary();
    for (;;) {
      skipWs();
      const c = peek();
      if (c === "*" || c === "/") {
        i++;
        const rhs = parseUnary(), left = node;
        node = x => c === "*" ? left(x) * rhs(x) : left(x) / rhs(x);
      } else if (canStartPrimary()) {
        const rhs = parseUnary(), left = node; // implicit multiplication: "2x", "3(x+1)"
        node = x => left(x) * rhs(x);
      } else break;
    }
    return node;
  }
  function parseUnary() {
    skipWs();
    const c = peek();
    if (c === "-") { i++; const node = parseUnary(); return x => -node(x); }
    if (c === "+") { i++; return parseUnary(); }
    return parsePow();
  }
  function parsePow() {
    const node = parsePrimary();
    skipWs();
    if (peek() === "^") {
      i++;
      const rhs = parseUnary();
      return x => Math.pow(node(x), rhs(x));
    }
    return node;
  }
  function parsePrimary() {
    skipWs();
    const c = peek();
    if (c === "(") {
      i++;
      const node = parseExpr();
      skipWs();
      if (peek() !== ")") throw new Error("expected ')'");
      i++;
      return node;
    }
    if (isDigit(c) || c === ".") {
      const start = i;
      while (isDigit(peek())) i++;
      if (peek() === ".") { i++; while (isDigit(peek())) i++; }
      const val = parseFloat(s.slice(start, i));
      return () => val;
    }
    if (isAlpha(c)) {
      const start = i;
      while (isAlpha(peek()) || isDigit(peek())) i++;
      const name = s.slice(start, i);
      skipWs();
      if (peek() === "(") {
        i++;
        const arg = parseExpr();
        skipWs();
        if (peek() !== ")") throw new Error(`expected ')' after ${name}(`);
        i++;
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        return x => fn(arg(x));
      }
      if (name === "x") return x => x;
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      throw new Error(`unknown identifier "${name}"`);
    }
    throw new Error(c === undefined ? "unexpected end of expression" : `unexpected character "${c}"`);
  }

  const result = parseExpr();
  skipWs();
  if (i < s.length) throw new Error(`unexpected trailing input "${s.slice(i)}"`);
  return result;
}

function buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax) {
  const steps = 240;
  const yRange = yMax - yMin || 1;
  const yClipLo = yMin - yRange * 3, yClipHi = yMax + yRange * 3;
  let d = "", penDown = false;
  for (let k = 0; k <= steps; k++) {
    const xVal = xMin + (xMax - xMin) * (k / steps);
    let yVal;
    try { yVal = fn(xVal); } catch (e) { yVal = NaN; }
    const valid = Number.isFinite(yVal) && yVal >= yClipLo && yVal <= yClipHi;
    if (!valid) { penDown = false; continue; }
    const px = mapX(xVal).toFixed(2), py = mapY(yVal).toFixed(2);
    d += (penDown ? "L" : "M") + px + " " + py + " ";
    penDown = true;
  }
  return d.trim();
}

/* ---------------- automatic axis fitting ----------------
   Working out a sensible Y range by hand is the tedious part of setting up a graph: "x from 0 to
   100, y = 150x + 100" means squinting at the equation to realise the top of the line is 15100 and
   the grid wants to count in 2000s. This samples the entered functions across the x range and
   suggests the Y min/max plus both grid increments, offered as a one-click "Apply" hint under the
   range fields rather than silently overwriting what the user typed. */
const GRAPH_FIT_TOOLS = {
  plane: {
    xMin: "planeXMin", xMax: "planeXMax", yMin: "planeYMin", yMax: "planeYMax",
    xStep: "planeXStep", yStep: "planeYStep",
    textarea: "planeFunctions", hint: "planeFitHint", hintText: "planeFitText",
  },
  planeMath: {
    xMin: "pmXMin", xMax: "pmXMax", yMin: "pmYMin", yMax: "pmYMax",
    xStep: "pmXStep", yStep: "pmYStep",
    fnList: "pmFnList", hint: "pmFitHint", hintText: "pmFitText",
  },
  // Quadrant 1 has no min fields at all — both axes start at 0 by definition.
  planeQ1: {
    xMin: null, xMax: "q1XMax", yMin: null, yMax: "q1YMax",
    xStep: "q1XStep", yStep: "q1YStep",
    fnList: "q1FnList", hint: "q1FitHint", hintText: "q1FitText", firstQuadrant: true,
  },
};
const GRAPH_FIT_TARGET_LINES = 10; // matches the tools' own -5..5-by-1 default feel

// Rounds a raw "range ÷ how many lines I want" figure to the nearest increment people actually
// label axes with — 1, 2 or 5 times a power of ten (… 0.5, 1, 2, 5, 10, 20, 50, 100 …).
function niceGridStep(range, targetLines) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, targetLines);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.max(0.001, Math.round(mult * mag * 1e6) / 1e6);
}
const tidyFitNum = v => Math.round(v * 1e6) / 1e6;

// The y values the given functions actually occupy across [xMin, xMax]. Asymptotes would otherwise
// decide the whole scale on their own (one sample next to x=0 in 1/x is worth millions), so when
// the full min→max span dwarfs the middle 96% of samples the outliers are dropped and the bulk of
// the curve gets fitted instead — flagged back to the caller so the hint can say so.
function sampleFnYRange(fns, xMin, xMax) {
  const steps = 400;
  const ys = [];
  for (const fn of fns) {
    for (let k = 0; k <= steps; k++) {
      const x = xMin + (xMax - xMin) * (k / steps);
      let y;
      try { y = fn(x); } catch (_) { continue; }
      if (Number.isFinite(y)) ys.push(y);
    }
  }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  const lo = ys[0], hi = ys[ys.length - 1];
  const qLo = ys[Math.floor(ys.length * 0.02)], qHi = ys[Math.ceil(ys.length * 0.98) - 1];
  if (qHi > qLo && hi - lo > (qHi - qLo) * 8) return { lo: qLo, hi: qHi, clipped: true };
  return { lo, hi, clipped: false };
}

// Every non-empty, ticked expression for this tool, compiled. Rows that don't parse are skipped
// silently here — they already surface as errors under the function list itself.
function graphFitFns(cfg) {
  const exprs = cfg.textarea
    ? $(cfg.textarea).value.split("\n").map(l => l.trim()).filter(Boolean)
    : Array.from($(cfg.fnList).querySelectorAll(".eq-row"))
        .filter(r => r.querySelector(".eq-enabled").checked)
        .map(r => r.querySelector(".eq-expr").value.trim())
        .filter(Boolean);
  const fns = [];
  for (const e of exprs) {
    try { fns.push(compileExpr(e)); } catch (_) {}
  }
  return fns;
}

// Returns {xStep, yStep?, yMin?, yMax?, clipped} — the Y range is only suggested when there's a
// plottable function to derive it from; the increments are suggested either way, since a hand-typed
// range like 0–100 still wants a grid of 10s rather than the default 1s.
function suggestGraphFit(cfg) {
  const xMin = cfg.xMin ? (parseFloat($(cfg.xMin).value) || 0) : 0;
  const xMax = parseFloat($(cfg.xMax).value);
  if (!Number.isFinite(xMax) || xMax <= xMin) return null;
  const out = { xStep: niceGridStep(xMax - xMin, GRAPH_FIT_TARGET_LINES), clipped: false };

  const fns = graphFitFns(cfg);
  const span = fns.length ? sampleFnYRange(fns, xMin, xMax) : null;
  if (span) {
    let lo = span.lo, hi = span.hi;
    if (cfg.firstQuadrant) {
      if (hi <= 0) return out; // nothing of the curve is in quadrant 1 — no Y range worth proposing
      lo = 0;
    }
    if (hi - lo <= 0) { // a constant function has no span of its own to scale to
      const pad = Math.max(Math.abs(hi), 1) * 0.5;
      hi += pad;
      if (!cfg.firstQuadrant) lo -= pad;
    }
    const yStep = niceGridStep(hi - lo, GRAPH_FIT_TARGET_LINES);
    out.yStep = yStep;
    out.yMin = cfg.firstQuadrant ? 0 : tidyFitNum(Math.floor(lo / yStep + 1e-9) * yStep);
    out.yMax = tidyFitNum(Math.ceil(hi / yStep - 1e-9) * yStep);
    out.clipped = span.clipped;
  } else {
    const yMin = cfg.yMin ? (parseFloat($(cfg.yMin).value) || 0) : 0;
    const yMax = parseFloat($(cfg.yMax).value);
    if (Number.isFinite(yMax) && yMax > yMin) out.yStep = niceGridStep(yMax - yMin, GRAPH_FIT_TARGET_LINES);
  }
  return out;
}

const fitFieldDiffers = (id, want) => {
  if (!id || want === undefined) return false;
  const cur = parseFloat($(id).value);
  return !Number.isFinite(cur) || Math.abs(cur - want) > Math.abs(want) * 1e-9 + 1e-9;
};
// Thousands separators here specifically: "16,000" is the whole point of the feature (reading
// "15100" off a raw equation is the mental arithmetic it's meant to save).
const fmtFitNum = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });

// An axis divided into this many steps is readable, so a grid increment landing in the band is
// left alone even when the fit would have chosen differently — 0–40 in 10s is a deliberate choice,
// not a mistake to be nagged about, and only a grid too coarse or too dense to read is worth
// flagging. Range fixes have no such band: a Y max that cuts the curve off is simply wrong.
const FIT_MIN_DIVS = 4, FIT_MAX_DIVS = 20;
const fitStepUnreadable = (id, range) => {
  const step = parseFloat($(id).value);
  if (!Number.isFinite(step) || step <= 0 || !(range > 0)) return true;
  const divs = range / step;
  return divs < FIT_MIN_DIVS || divs > FIT_MAX_DIVS;
};
// The fields the hint offers to change, keyed by config field name — the single source of truth
// for both the hint text and what Apply writes, so the two can never disagree.
function graphFitChanges(cfg) {
  const fit = suggestGraphFit(cfg);
  if (!fit) return null;
  const xMin = cfg.xMin ? (parseFloat($(cfg.xMin).value) || 0) : 0;
  const xMax = parseFloat($(cfg.xMax).value);
  // Grid increments are judged against the range as it will stand AFTER the fit is applied —
  // a step of 1 is fine on today's 0–10 axis but useless once the axis becomes 0–16000.
  const yMin = fit.yMin !== undefined ? fit.yMin : (cfg.yMin ? (parseFloat($(cfg.yMin).value) || 0) : 0);
  const yMax = fit.yMax !== undefined ? fit.yMax : parseFloat($(cfg.yMax).value);
  const out = { clipped: fit.clipped, fields: {} };
  if (fitFieldDiffers(cfg.yMin, fit.yMin)) out.fields.yMin = fit.yMin;
  if (fitFieldDiffers(cfg.yMax, fit.yMax)) out.fields.yMax = fit.yMax;
  if (fitFieldDiffers(cfg.yStep, fit.yStep) && fitStepUnreadable(cfg.yStep, yMax - yMin)) out.fields.yStep = fit.yStep;
  if (fitFieldDiffers(cfg.xStep, fit.xStep) && fitStepUnreadable(cfg.xStep, xMax - xMin)) out.fields.xStep = fit.xStep;
  return out;
}

function applyGraphFit(type) {
  const cfg = GRAPH_FIT_TOOLS[type];
  const changes = cfg && graphFitChanges(cfg);
  if (!changes) return;
  for (const [key, val] of Object.entries(changes.fields)) {
    if (cfg[key]) $(cfg[key]).value = val;
  }
  renderShapePreview();
}

// Shows/hides the "Apply" hint for whichever graph tool is open, listing only the values that
// would actually change (so a graph that's already fitted shows nothing at all).
function updateGraphFitHint() {
  const type = $("shapeTypeSelect").value;
  for (const [t, cfg] of Object.entries(GRAPH_FIT_TOOLS)) {
    if (t !== type && $(cfg.hint)) $(cfg.hint).style.display = "none";
  }
  const cfg = GRAPH_FIT_TOOLS[type];
  if (!cfg || !$(cfg.hint)) return;
  let changes = null;
  try { changes = graphFitChanges(cfg); } catch (_) {}
  const LABELS = { yMin: "Y min", yMax: "Y max", yStep: "Y grid", xStep: "X grid" };
  const parts = changes
    ? Object.entries(changes.fields).map(([k, v]) => `${LABELS[k]} <b>${fmtFitNum(v)}</b>`)
    : [];
  if (!parts.length) { $(cfg.hint).style.display = "none"; return; }
  $(cfg.hintText).innerHTML = "Suggested fit: " + parts.join(" &middot; ") +
    (changes.clipped ? ' <span style="opacity:.7;">(ignoring asymptote spikes)</span>' : "");
  $(cfg.hint).style.display = "flex";
}

// Parses each raw field string as a plain positive number; returns null (not partial results)
// if ANY value fails, since mixing a real number with a variable like "x" can't be scaled sensibly.
function tryParseDims(strs) {
  const nums = strs.map(s => parseFloat(s));
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return null;
  return nums;
}
// Converts unit values to pixel dimensions at `pxPerUnit`, preserving their relative ratio exactly,
// then uniformly rescales (never distorting the ratio) so the largest dimension lands in [minPx, maxPx].
function scaleToPixels(nums, pxPerUnit, minPx, maxPx) {
  let px = nums.map(n => n * pxPerUnit);
  const maxRaw = Math.max(...px);
  if (maxRaw > maxPx) { const f = maxPx / maxRaw; px = px.map(v => v * f); }
  const maxAfter = Math.max(...px);
  if (maxAfter < minPx) { const f = minPx / maxAfter; px = px.map(v => v * f); }
  return px;
}

// Midpoint of an edge, nudged outward (away from a reference center point) along the edge's own
// perpendicular — the label sits at a consistent clearance from the edge regardless of the edge's
// angle, instead of a fixed x/y offset that only looks right for the one angle it was tuned at
// (e.g. a depth edge whose angle changes with the "Perspective" slider).
function labelOffEdge(p1, p2, center, dist) {
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (nx * (mx - center.x) + ny * (my - center.y) < 0) { nx = -nx; ny = -ny; }
  return { x: mx + nx * dist, y: my + ny * dist };
}
