"use strict";
/* ---------------- axis tick number formatting ----------------
   A physics diagram lives and dies by significant figures: an axis counting 2.0, 4.0, 6.0 states a
   precision that one counting 2, 4, 6 does not. JavaScript's default number-to-string drops exactly
   the trailing zeros that carry that meaning, so each graph tool picks a format for its tick
   numbers instead of always taking that default. */
// Rounds to n significant figures, keeping the trailing zeros that carry the precision but never
// adding a decimal point to a value that doesn't need one — 2 s.f. gives "2.0" and "10", which is
// the convention textbooks use along an axis.
function sigFigStr(v, n) {
  if (!Number.isFinite(v) || v === 0) return "0";
  const intDigits = Math.floor(Math.log10(Math.abs(v))) + 1;
  return v.toFixed(Math.max(0, n - intDigits));
}
const TICK_FMT_AUTO = v => (Math.round(v * 1e6) / 1e6).toString();
const TICK_FMTS = {
  auto: TICK_FMT_AUTO,
  sf2: v => sigFigStr(v, 2),
  sf3: v => sigFigStr(v, 3),
  sf4: v => sigFigStr(v, 4),
  d1: v => v.toFixed(1),
  d2: v => v.toFixed(2),
  d3: v => v.toFixed(3),
};
const tickFmtFrom = selId => TICK_FMTS[$(selId) ? $(selId).value : "auto"] || TICK_FMT_AUTO;
// Rough rendered width of an axis label. The SVG is built as a string with no measuring context
// available, and 0.55em per character averages out well for the bold italic serif used here.
// How wide an axis title draws, which decides how much margin the plot gives up to it. Character
// count is right for prose but wildly over-reserves for a formula — "$\frac{1}{2}mv^2$ (J)" counts
// 22 characters and draws about eight wide — so a rendered formula is measured instead.
const estAxisLabelW = (s, fontSize) =>
  lineHasMath(s) ? shapeLabelMetrics(s, fontSize, AXIS_LABEL_CSS).w : s.length * fontSize * 0.55;

/* ---------------- labels that can contain "$...$" ----------------
   A label goes out as a plain <text> unless it holds maths, in which case the KaTeX output is
   nested in a <foreignObject> so it stays real vector text like the rest of the diagram rather
   than a pasted-in bitmap.

   Two things make this work. The faces each label needs are collected here and emitted once per
   SVG (see shapeMathStyleTag) — a placed shape is a self-contained data: URL that can load nothing
   external, so the fonts have to travel with it, and repeating them per label would be absurd.
   And the same helper builds the preview and the placed shape, so what you design is what you get.

   A formula's first render is asynchronous. Until it lands the label falls back to its raw source,
   and shapeMathOnReady redraws the preview when it's ready. */
let shapeMathFaces = new Set(); // reset per build; graphPlaneSvg builds its own string, so this can't be a return value
// An axis title's typography, in the two forms the two rendering routes need: SVG attributes for a
// plain <text>, and the equivalent CSS so the prose around a formula matches it inside a
// <foreignObject>. Kept adjacent so they can't drift apart.
const AXIS_LABEL_ATTRS = 'font-family="serif" font-style="italic" font-weight="bold"';
const AXIS_LABEL_CSS = "font-family:serif; font-style:italic; font-weight:bold;";
// The same pair for a shape's own labels (a triangle's sides and angles, a solid's edges).
const SHAPE_LABEL_ATTRS = 'font-family="Arial, sans-serif" font-weight="bold" pointer-events="none"';
const SHAPE_LABEL_CSS = "font-family:Arial,sans-serif; font-weight:bold;";

function shapeLabelSvg(text, opts) {
  const { x, y, fontSize, anchor = "middle", fill = "#000", attrs = "", transform = "", cssFont = "" } = opts;
  const tf = transform ? ` transform="${transform}"` : "";
  const plain = () =>
    `  <text x="${x}" y="${y}" font-size="${fontSize}" text-anchor="${anchor}" fill="${fill}"${tf} ${attrs}>${escapeXml(text)}</text>\n`;
  if (!lineHasMath(text)) return plain();
  ensureKatexCssInDocument(); // what makes the preview render without carrying any fonts itself
  const m = getShapeMath(text, fontSize, cssFont);
  if (!m || m.failed || !m.w) return plain(); // still rendering, or KaTeX is unreachable
  for (const k of m.faceKeys) shapeMathFaces.add(k);
  // <text> is placed by its baseline and pulled sideways by text-anchor; a <foreignObject> is
  // placed by its top-left corner. baselineOffset is the gap between the two.
  const left = anchor === "start" ? x : anchor === "end" ? x - m.w : x - m.w / 2;
  return `  <foreignObject x="${left}" y="${y + m.baselineOffset}" width="${Math.ceil(m.w) + 2}" height="${Math.ceil(m.h) + 2}"${tf}>\n` +
    `    <div xmlns="http://www.w3.org/1999/xhtml"><span style="${m.style} color:${fill};">${m.html}</span></div>\n` +
    `  </foreignObject>\n`;
}
/* How wide and tall a label actually draws. A character-count estimate is fine for plain text but
   badly wrong for maths — "$\frac{1}{2}mv^2$" is 17 source characters and draws about six wide —
   and these numbers decide the preview's crop box, its click targets, and the centring of the text
   object each label becomes when placed. Uses the real measurement whenever the formula has
   finished rendering, and falls back to the old estimate until it has. */
function shapeLabelMetrics(text, fontSize, cssFont = "") {
  const str = String(text);
  if (lineHasMath(str)) {
    const m = getShapeMath(str, fontSize, cssFont);
    if (m && !m.failed && m.w) return { w: m.w, h: m.h };
  }
  return { w: Math.max(28, str.length * fontSize * 0.62), h: fontSize * 1.35 };
}

/* ---------------- a shape's font payload, stored by reference ----------------

   A placed shape is a standalone data: URL that can load nothing external, so to draw maths it
   needs the KaTeX stylesheet and its woff2 faces physically inside it — about 82KB. But
   doc.images[].data is serialized verbatim (see serialize in pages-pdf.js), so embedding that in
   each shape would put 82KB into IndexedDB and every Drive sync per graph on the page.

   So the stored SVG carries a ~40-byte list of the faces it needs instead, and the notebook saves
   one shared copy of the stylesheet for all of them (see katexCssBundleFor). The fonts are spliced
   back in at the two moments a copy has to stand on its own: decoding into an <img>, and export.
   Same shape as pdfSources — a notebook-level side table the images point into.

   Most shapes are not marked at all: a triangle's labels leave the SVG and become text objects
   at placement, so there is no maths left in the file to need a font. In practice only a graph —
   whose axis titles must stay inside to survive re-editing — is ever stamped. The dialog preview
   is an inline SVG in this document and picks the stylesheet up from the page for free (see
   ensureKatexCssInDocument), so it is not stamped either. */
const SHAPE_MATH_FACE_ATTR = "data-katex-faces";
const SHAPE_SVG_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";
// Face keys are "Family|weight|style" built from KaTeX's own stylesheet (see katexFaceKey), so
// they hold nothing that needs XML-escaping and no commas to confuse the join.
function stampShapeMathFaces(svg) {
  const faces = [...shapeMathFaces];
  if (!faces.length) return svg;
  return svg.replace(/^<svg\b/, `<svg ${SHAPE_MATH_FACE_ATTR}="${faces.join(",")}"`);
}
const shapeMathFaceList = svg => {
  const m = new RegExp(`<svg\\b[^>]*\\b${SHAPE_MATH_FACE_ATTR}="([^"]*)"`).exec(String(svg));
  return m && m[1] ? m[1].split(",") : [];
};
// Puts the fonts back. Unchanged for anything that was never stamped, and unchanged when neither
// the live stylesheet nor a saved one is available yet — callers retry, see setShapeImgSrc.
function inflateShapeMathCss(svg) {
  const css = katexCssForFaces(shapeMathFaceList(svg));
  if (!css) return svg;
  return svg.replace(/^(<svg[^>]*>\n?)/, `$1<style data-katex="1">${css}</style>\n`);
}
// The same, for the data: URL form the images actually hold. The attribute NAME survives
// encodeURIComponent untouched (letters and hyphens are unreserved), so this stays a cheap string
// test for the overwhelmingly common case of an image that isn't a maths-labelled shape at all.
const shapeDataHasMath = d => typeof d === "string" && d.includes(SHAPE_MATH_FACE_ATTR);
function inflateShapeDataUrl(data) {
  if (!shapeDataHasMath(data) || !data.startsWith(SHAPE_SVG_URL_PREFIX)) return data;
  const svg = decodeURIComponent(data.slice(SHAPE_SVG_URL_PREFIX.length));
  const out = inflateShapeMathCss(svg);
  return out === svg ? data : SHAPE_SVG_URL_PREFIX + encodeURIComponent(out);
}
function shapeDataFaceKeys(data) {
  if (!shapeDataHasMath(data) || !data.startsWith(SHAPE_SVG_URL_PREFIX)) return [];
  try { return shapeMathFaceList(decodeURIComponent(data.slice(SHAPE_SVG_URL_PREFIX.length))); }
  catch (_) { return []; }
}
/* Points an <img> at a shape, fonts included. The stylesheet may not be there yet — a notebook
   saved before the fonts were hoisted has none of its own, and KaTeX is fetched fresh each session
   — so when it isn't, this draws the shape unstyled now and re-points the same <img> once it
   arrives rather than leaving a blank. The existing onload handlers redraw either way. */
function setShapeImgSrc(img, data) {
  const withFonts = inflateShapeDataUrl(data);
  img.src = withFonts;
  if (withFonts !== data || !shapeDataHasMath(data)) return;
  loadKatexCssParts().then(() => {
    const retry = inflateShapeDataUrl(data);
    if (retry !== data) img.src = retry;
  }).catch(() => {});
}
/* Migration for notebooks saved before the hoist, whose graphs each embed the whole stylesheet.
   Lifts it out into the shared copy and leaves the same marker a fresh shape gets, so reopening one
   and saving it shrinks the file — and so its fonts still work offline, which was the only thing
   that embedded copy was buying. Returns the slimmed SVG, or the original if it wasn't embedded. */
function demoteShapeMathCss(svg) {
  const m = /<style data-katex="1">([\s\S]*?)<\/style>\n?/.exec(svg);
  if (!m) return svg;
  const parts = katexCssPartsFromText(m[1]);
  const keys = Object.keys(parts.faces);
  if (!keys.length) return svg;
  registerSavedKatexCss({ base: parts.base, faces: parts.faces });
  const bare = svg.replace(m[0], "");
  return shapeMathFaceList(bare).length ? bare
    : bare.replace(/^<svg\b/, `<svg ${SHAPE_MATH_FACE_ATTR}="${keys.join(",")}"`);
}
function demoteShapeDataUrl(data) {
  if (typeof data !== "string" || !data.startsWith(SHAPE_SVG_URL_PREFIX) ||
      !data.includes("data-katex")) return data;
  const svg = decodeURIComponent(data.slice(SHAPE_SVG_URL_PREFIX.length));
  const out = demoteShapeMathCss(svg);
  return out === svg ? data : SHAPE_SVG_URL_PREFIX + encodeURIComponent(out);
}

function buildMathShapeSVG() {
  const type = $("shapeTypeSelect").value;
  shapeMathFaces = new Set();
  let svgString = "";
  const labelSpecs = []; // {x, y, text, fontSize, field?} in the SVG-local coordinate space
  let srcBox = null; // {x, y, w, h} — the SVG-local crop box labelSpecs coordinates are relative to
  /* Interaction metadata for the live preview, in that same SVG-local space. Deliberately built
     here rather than inferred afterwards: this function is the only place that knows the forward
     transform from field values to pixels, so it's the only place that can state the inverse
     honestly. Nothing below is drawn into the SVG — generateAndInsertMathShape() calls this
     function again for the real insert, so the overlay can never end up in the placed shape.
       hotspots — {cx, cy, w, h, field, title}: click the thing on the shape, edit that field there.
       handles  — {cx, cy, kind, title, apply(pt) -> {fieldId: value}}: drag it. */
  const hotspots = [], handles = [];
  let fnErrors = []; // parse/eval errors from the "Plot Functions" fields, by function
  const size = 500;

  // Shared by both coordinate-plane tools (plane, planeMath).
  function ticksFor(min, max, step) {
    const arr = [];
    const startI = Math.ceil(min / step - 1e-9);
    for (let i = startI; i * step <= max + 1e-9; i++) {
      const v = i * step;
      if (Math.abs(v) > 1e-9) arr.push(v);
    }
    return arr;
  }
  const fnColors = ["#DC2626", "#2563EB", "#16A34A", "#9333EA", "#D97706", "#0891B2"];
  // The "0" where the axes meet, which ticksFor() deliberately leaves out of both tick lists (it
  // would otherwise be drawn twice, once per axis). Sits in the same row as the x-axis numbers and
  // the same column as the y-axis numbers, so it reads as the shared origin of both.
  const originZeroSvg = (originX, originY, xTickOffset, axisFontSize, fmt) =>
    `  <text x="${originX - 10}" y="${originY + xTickOffset}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmt(0)}</text>\n`;

  /* Shared renderer for the two full-featured coordinate-plane tools (planeMath and planeQ1).
     Those branches used to be ~95% identical line for line — every margin/tick/label/legend
     calculation below existed twice, and the Q1 copy's own comments said "see the matching note in
     the planeMath branch," which is exactly the maintenance burden this removes: a fix to the axis
     label or tick-margin math now only has to be made once instead of hand-mirrored.

     Their genuine differences are all parameters here: which field ids to read (done by the caller,
     since the clamping rules differ too), whether the axes get negative-direction arrowheads, and
     which function-list container to read equations from. The plain "plane" tool deliberately does
     NOT share this — it has no axis labels, no arrowheads and a different function input, so folding
     it in would mean gating most of this on flags and would read worse than leaving it separate. */
  function graphPlaneSvg(o) {
    const { xMin, xMax, yMin, yMax, drawGrid, fmtNum, showZero, axisFontSize, gridThickness,
            bgEnabled, bgColor, labelAxes, xAxisLabel, yAxisLabel, showLegend, fnListSel,
            negativeArrows } = o;
    const legendFontSize = Math.max(9, axisFontSize - 1);
    // Guard against pathologically fine steps (huge ranges, tiny increments) blowing up rendering
    // by auto-coarsening, while still covering the full range.
    const maxGridLines = 200;
    let xStep = o.xStep, yStep = o.yStep;
    if ((xMax - xMin) / xStep > maxGridLines) xStep = (xMax - xMin) / maxGridLines;
    if ((yMax - yMin) / yStep > maxGridLines) yStep = (yMax - yMin) / maxGridLines;

    const xTicks = ticksFor(xMin, xMax, xStep);
    const yTicks = ticksFor(yMin, yMax, yStep);

    const pad = 40;
    const axisLabelSize = axisFontSize + 2;
    // The compact positions — "F (N)" above the y-axis arrowhead, "s (m)" past the x-axis one —
    // sit OUTSIDE the plot box, so the margins have to be widened to hold them or the label runs
    // off the edge of the SVG and is clipped (which is exactly what a fixed 40px margin did to
    // anything longer than a single letter). Past roughly a quarter of the canvas the margin a
    // label demands starts eating the graph itself, so genuinely long ones ("Distance (d km)")
    // switch to the title-style layout instead: x-axis label centered below the tick numbers,
    // y-axis label rotated in a reserved strip along the left edge.
    const xLabelW = labelAxes ? estAxisLabelW(xAxisLabel, axisLabelSize) : 0;
    const yLabelW = labelAxes ? estAxisLabelW(yAxisLabel, axisLabelSize) : 0;
    const wideAxisLabels = labelAxes && (xLabelW > size * 0.24 || yLabelW > size * 0.5);
    // Left margin must fit the widest y-axis number — triple-digit labels (e.g. "100") were
    // getting clipped off the canvas edge at the old fixed 40px pad. Quadrant-1 graphs hit this
    // constantly since the origin (and therefore every y-axis label) is always pinned to the left
    // edge, unlike the 4-quadrant layout where the origin can sit further in.
    const maxYLabelChars = yTicks.length ? Math.max(...yTicks.map(v => fmtNum(v).length)) : 1;
    const tickPadLeft = Math.min(size / 2 - 20, Math.max(pad, Math.ceil(maxYLabelChars * axisFontSize * 0.62) + 18));
    const yLabelStripW = wideAxisLabels ? axisLabelSize + 16 : 0;
    // A compact y-axis label is centered on the y-axis, so half of it overhangs to the left and
    // the left margin has to cover that too.
    const padLeft = Math.max(tickPadLeft + yLabelStripW, wideAxisLabels ? 0 : yLabelW / 2 + 6);
    // Vertical offset for x-axis tick numbers scales with font size so larger labels
    // still clear the axis line instead of overlapping it.
    const xTickOffset = Math.round(axisFontSize * 0.85) + 8;
    const padBottom = wideAxisLabels ? Math.max(pad, xTickOffset + axisLabelSize + 14) : pad;
    const padRight = wideAxisLabels ? pad : Math.max(pad, xLabelW + 16);
    const padTop = wideAxisLabels ? pad : Math.max(pad, axisLabelSize + 10);
    const graphW = size - padLeft - padRight;
    const graphH = size - padTop - padBottom;
    const mapX = val => padLeft + ((val - xMin) / (xMax - xMin)) * graphW;
    const mapY = val => padTop + ((yMax - val) / (yMax - yMin)) * graphH;

    let innerSvg = "";
    if (drawGrid) {
      innerSvg += `<!-- Sub-grid structures -->\n`;
      for (const x of xTicks) {
        const cx = mapX(x);
        innerSvg += `  <line x1="${cx}" y1="${padTop}" x2="${cx}" y2="${size-padBottom}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
      for (const y of yTicks) {
        const cy = mapY(y);
        innerSvg += `  <line x1="${padLeft}" y1="${cy}" x2="${size-padRight}" y2="${cy}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
    }
    const originX = mapX(0); const originY = mapY(0);
    innerSvg += `<!-- Master Axis -->\n  <line x1="${padLeft}" y1="${originY}" x2="${size-padRight}" y2="${originY}" stroke="black" stroke-width="2"/>\n`;
    innerSvg += `  <line x1="${originX}" y1="${padTop}" x2="${originX}" y2="${size-padBottom}" stroke="black" stroke-width="2"/>\n`;
    // Arrowheads matching the number-line tool's style. The negative-direction pair is skipped for
    // a quadrant-1 graph, where the origin sits at the box's bottom-left corner and there is no
    // negative direction to point into.
    innerSvg += `  <path d="M ${size-padRight} ${originY} L ${size-padRight-12} ${originY-6} L ${size-padRight-12} ${originY+6} Z" fill="black"/>\n`;
    if (negativeArrows) innerSvg += `  <path d="M ${padLeft} ${originY} L ${padLeft+12} ${originY-6} L ${padLeft+12} ${originY+6} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${originX} ${padTop} L ${originX-6} ${padTop+12} L ${originX+6} ${padTop+12} Z" fill="black"/>\n`;
    if (negativeArrows) innerSvg += `  <path d="M ${originX} ${size-padBottom} L ${originX-6} ${size-padBottom-12} L ${originX+6} ${size-padBottom-12} Z" fill="black"/>\n`;
    for (const x of xTicks) {
      innerSvg += `  <text x="${mapX(x)}" y="${originY + xTickOffset}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="middle">${fmtNum(x)}</text>\n`;
    }
    for (const y of yTicks) {
      innerSvg += `  <text x="${originX - 10}" y="${mapY(y) + 4}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmtNum(y)}</text>\n`;
    }
    if (showZero) innerSvg += originZeroSvg(originX, originY, xTickOffset, axisFontSize, fmtNum);
    /* Click targets sitting on the four axis extremes. The range is the thing you retune most while
       actually looking at a graph ("that's cut off at the top"), and it was only reachable as four
       numeric fields off to the side — which means translating what you can see back into which of
       X/Y Min/Max to change. Q1 passes no min ids: its origin is pinned to (0,0), so there is
       nothing there to edit. */
    const rf = o.rangeFields || {};
    const hotW = Math.max(46, axisFontSize * 2.8), hotH = axisFontSize + 14;
    const yNudge = axisFontSize * 0.35;
    if (rf.xMin) hotspots.push({ cx: padLeft, cy: originY + xTickOffset - yNudge, w: hotW, h: hotH, field: rf.xMin, title: "x min" });
    if (rf.xMax) hotspots.push({ cx: size - padRight, cy: originY + xTickOffset - yNudge, w: hotW, h: hotH, field: rf.xMax, title: "x max" });
    if (rf.yMax) hotspots.push({ cx: originX - 10 - hotW / 2, cy: padTop + 4 - yNudge, w: hotW, h: hotH, field: rf.yMax, title: "y max" });
    if (rf.yMin) hotspots.push({ cx: originX - 10 - hotW / 2, cy: size - padBottom + 4 - yNudge, w: hotW, h: hotH, field: rf.yMin, title: "y min" });
    if (labelAxes && wideAxisLabels) {
      const yLabelX = yLabelStripW / 2 + 4;
      const yLabelY = (padTop + (size - padBottom)) / 2;
      innerSvg += shapeLabelSvg(yAxisLabel, { x: yLabelX, y: yLabelY, fontSize: axisLabelSize,
        transform: `rotate(-90 ${yLabelX} ${yLabelY})`, attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });
      const xLabelX = (padLeft + (size - padRight)) / 2;
      const xLabelY = (size - padBottom) + xTickOffset + axisLabelSize - 2;
      innerSvg += shapeLabelSvg(xAxisLabel, { x: xLabelX, y: xLabelY, fontSize: axisLabelSize,
        attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });
    } else if (labelAxes) {
      // "y" sits on the y-axis, above its arrowhead; "x" sits outside the plot, past the x-axis arrowhead.
      innerSvg += shapeLabelSvg(xAxisLabel, { x: size - padRight + 10, y: originY + 5, fontSize: axisLabelSize,
        anchor: "start", attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });
      innerSvg += shapeLabelSvg(yAxisLabel, { x: originX, y: padTop - 12, fontSize: axisLabelSize,
        attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });
    }

    // Clips plotted curves to the grid box — without it, steep functions (e.g. y=6x) compute
    // pixel coordinates far outside the box and the line spills into the margin/legend instead
    // of stopping at the axes.
    innerSvg += `  <defs><clipPath id="plotClip"><rect x="${padLeft}" y="${padTop}" width="${graphW}" height="${graphH}"/></clipPath></defs>\n`;
    const fnRows = Array.from(document.querySelectorAll(fnListSel));
    let legendY = padTop + legendFontSize;
    fnRows.forEach((row, idx) => {
      const enabled = row.querySelector(".eq-enabled").checked;
      const expr = row.querySelector(".eq-expr").value.trim();
      const customLabel = row.querySelector(".eq-label").value.trim();
      if (!expr || !enabled) return;
      const color = fnColors[idx % fnColors.length];
      try {
        const fn = compileExpr(expr);
        const d = buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax);
        if (d) innerSvg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="2" clip-path="url(#plotClip)"/>\n`;
        if (showLegend) {
          const legendText = customLabel || (labelAxes ? `${yAxisLabel} = ${expr}` : expr);
          innerSvg += `  <rect x="${padLeft + 4}" y="${legendY - legendFontSize + 2}" width="${legendFontSize}" height="${legendFontSize}" fill="${color}"/>\n`;
          innerSvg += `  <text x="${padLeft + legendFontSize + 8}" y="${legendY}" font-family="ui-monospace, monospace" font-size="${legendFontSize}" fill="#333">${escapeXml(legendText)}</text>\n`;
          legendY += legendFontSize + 6;
        }
      } catch (err) {
        fnErrors.push(`"${expr}": ${err.message}`);
      }
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n<rect width="100%" height="100%" fill="${bgEnabled ? bgColor : "none"}"/>\n${innerSvg}</svg>`;
  }
  // Reads the shared set of graph controls for one tool, given its field-id prefix — the ids differ
  // only by that prefix ("pm"/"q1"), so the two callers' field wiring was identical apart from it.
  const graphFieldsFor = p => ({
    drawGrid: $(p + "GridLines").checked,
    fmtNum: tickFmtFrom(p + "TickFmt"),
    showZero: $(p + "ShowZero").checked,
    axisFontSize: parseInt($(p + "FontSize").value) || 20,
    bgEnabled: $(p + "BgEnabled").checked,
    bgColor: $(p + "BgColor").value || "#ffffff",
    labelAxes: $(p + "LabelAxes").checked,
    xAxisLabel: $(p + "AxisXLabel").value.trim() || "x",
    yAxisLabel: $(p + "AxisYLabel").value.trim() || "y",
    showLegend: $(p + "ShowLegend").checked,
    xStep: Math.max(0.0001, parseFloat($(p + "XStep").value) || 1),
    yStep: Math.max(0.0001, parseFloat($(p + "YStep").value) || 1),
    fnListSel: `#${p}FnList .eq-row`,
  });

  if (type === "plane") {
    const xMin = parseFloat($("planeXMin").value) || -5;
    const xMax = parseFloat($("planeXMax").value) || 5;
    const yMin = parseFloat($("planeYMin").value) || -5;
    const yMax = parseFloat($("planeYMax").value) || 5;
    const drawGrid = $("planeGridLines").checked;
    const fmtNum = tickFmtFrom("planeTickFmt");
    const showZero = $("planeShowZero").checked;
    const axisFontSize = parseInt($("planeFontSize").value) || 20;
    const legendFontSize = Math.max(9, axisFontSize - 1);
    const gridThickness = parseFloat($("planeGridThickness").value) || 2;
    const bgEnabled = $("planeBgEnabled").checked;
    const bgColor = $("planeBgColor").value || "#ffffff";
    // Increments are user-settable now; guard against pathologically fine steps (huge ranges,
    // tiny increments) blowing up rendering by auto-coarsening while still covering the full range.
    const maxGridLines = 200;
    let xStep = Math.max(0.0001, parseFloat($("planeXStep").value) || 1);
    let yStep = Math.max(0.0001, parseFloat($("planeYStep").value) || 1);
    if ((xMax - xMin) / xStep > maxGridLines) xStep = (xMax - xMin) / maxGridLines;
    if ((yMax - yMin) / yStep > maxGridLines) yStep = (yMax - yMin) / maxGridLines;

    const xTicks = ticksFor(xMin, xMax, xStep);
    const yTicks = ticksFor(yMin, yMax, yStep);

    const pad = 40;
    // Left margin must fit the widest y-axis number — triple-digit labels (e.g. "100") were
    // getting clipped off the canvas edge at the old fixed 40px pad.
    const maxYLabelChars = yTicks.length ? Math.max(...yTicks.map(v => fmtNum(v).length)) : 1;
    const padLeft = Math.min(size / 2 - 20, Math.max(pad, Math.ceil(maxYLabelChars * axisFontSize * 0.62) + 18));
    const graphW = size - padLeft - pad;
    const graphH = size - pad * 2;
    const mapX = val => padLeft + ((val - xMin) / (xMax - xMin)) * graphW;
    const mapY = val => pad + ((yMax - val) / (yMax - yMin)) * graphH;
    // Vertical offset for x-axis tick numbers scales with font size so larger labels
    // still clear the axis line instead of overlapping it.
    const xTickOffset = Math.round(axisFontSize * 0.85) + 8;
    // Same axis-extreme click targets the shared planeMath/planeQ1 renderer emits — repeated here
    // rather than shared because this branch deliberately doesn't use that renderer (different
    // margins, no axis labels, no arrowheads); see graphPlaneSvg's own note.
    {
      const oX = mapX(0), oY = mapY(0);
      const hotW = Math.max(46, axisFontSize * 2.8), hotH = axisFontSize + 14, yNudge = axisFontSize * 0.35;
      hotspots.push({ cx: padLeft, cy: oY + xTickOffset - yNudge, w: hotW, h: hotH, field: "planeXMin", title: "x min" });
      hotspots.push({ cx: size - pad, cy: oY + xTickOffset - yNudge, w: hotW, h: hotH, field: "planeXMax", title: "x max" });
      hotspots.push({ cx: oX - 10 - hotW / 2, cy: pad + 4 - yNudge, w: hotW, h: hotH, field: "planeYMax", title: "y max" });
      hotspots.push({ cx: oX - 10 - hotW / 2, cy: size - pad + 4 - yNudge, w: hotW, h: hotH, field: "planeYMin", title: "y min" });
    }

    let innerSvg = "";
    if (drawGrid) {
      innerSvg += `<!-- Sub-grid structures -->\n`;
      for (const x of xTicks) {
        const cx = mapX(x);
        innerSvg += `  <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${size-pad}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
      for (const y of yTicks) {
        const cy = mapY(y);
        innerSvg += `  <line x1="${padLeft}" y1="${cy}" x2="${size-pad}" y2="${cy}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
    }
    const originX = mapX(0); const originY = mapY(0);
    innerSvg += `<!-- Master Axis -->\n  <line x1="${padLeft}" y1="${originY}" x2="${size-pad}" y2="${originY}" stroke="black" stroke-width="2"/>\n`;
    innerSvg += `  <line x1="${originX}" y1="${pad}" x2="${originX}" y2="${size-pad}" stroke="black" stroke-width="2"/>\n`;
    for (const x of xTicks) {
      innerSvg += `  <text x="${mapX(x)}" y="${originY + xTickOffset}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="middle">${fmtNum(x)}</text>\n`;
    }
    for (const y of yTicks) {
      innerSvg += `  <text x="${originX - 10}" y="${mapY(y) + 4}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmtNum(y)}</text>\n`;
    }
    if (showZero) innerSvg += originZeroSvg(originX, originY, xTickOffset, axisFontSize, fmtNum);

    // Clips plotted curves to the grid box — without it, steep functions (e.g. y=6x) compute
    // pixel coordinates far outside the box and the line spills into the margin/legend instead
    // of stopping at the axes.
    innerSvg += `  <defs><clipPath id="plotClip"><rect x="${padLeft}" y="${pad}" width="${graphW}" height="${graphH}"/></clipPath></defs>\n`;
    const fnLines = $("planeFunctions").value.split("\n").map(l => l.trim()).filter(Boolean);
    let legendY = pad + legendFontSize;
    fnLines.forEach((line, idx) => {
      const color = fnColors[idx % fnColors.length];
      try {
        const fn = compileExpr(line);
        const d = buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax);
        if (d) innerSvg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="2" clip-path="url(#plotClip)"/>\n`;
        innerSvg += `  <rect x="${padLeft + 4}" y="${legendY - legendFontSize + 2}" width="${legendFontSize}" height="${legendFontSize}" fill="${color}"/>\n`;
        innerSvg += `  <text x="${padLeft + legendFontSize + 8}" y="${legendY}" font-family="ui-monospace, monospace" font-size="${legendFontSize}" fill="#333">${escapeXml(line)}</text>\n`;
        legendY += legendFontSize + 6;
      } catch (err) {
        fnErrors.push(`Line ${idx + 1} ("${line}"): ${err.message}`);
      }
    });

    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n<rect width="100%" height="100%" fill="${bgEnabled ? bgColor : "none"}"/>\n${innerSvg}</svg>`;

  } else if (type === "planeMath") {
    const xMin = parseFloat($("pmXMin").value) || -5;
    const xMax = parseFloat($("pmXMax").value) || 5;
    const yMin = parseFloat($("pmYMin").value) || -5;
    const yMax = parseFloat($("pmYMax").value) || 5;
    svgString = graphPlaneSvg({
      ...graphFieldsFor("pm"),
      rangeFields: { xMin: "pmXMin", xMax: "pmXMax", yMin: "pmYMin", yMax: "pmYMax" },
      xMin, xMax, yMin, yMax,
      gridThickness: parseFloat($("pmGridThickness").value) || 1.5,
      negativeArrows: true,
    });

  } else if (type === "planeQ1") {
    // Quadrant 1 only: the origin is always pinned to (0, 0) rather than read from fields, and the
    // maxima are clamped positive so a zero/blank entry can't collapse the axis range.
    svgString = graphPlaneSvg({
      ...graphFieldsFor("q1"),
      rangeFields: { xMax: "q1XMax", yMax: "q1YMax" }, // no mins: the origin is pinned to (0,0)
      xMin: 0, yMin: 0,
      xMax: Math.max(0.0001, parseFloat($("q1XMax").value) || 10),
      yMax: Math.max(0.0001, parseFloat($("q1YMax").value) || 10),
      gridThickness: parseFloat($("q1GridThickness").value) || 2,
      negativeArrows: false,
    });

  } else if (type === "triangle") {
    const isRight = $("triRightAngle").checked;
    const rotationDeg = parseFloat($("triRotation").value) || 0;

    const lblBottom = $("triBottom").value;
    const lblLeft = $("triLeft").value;
    const lblRight = $("triRight").value;
    
    const txtAngleA = isRight ? "" : $("triAngleA").value;
    const txtAngleB = $("triAngleB").value;
    const txtAngleC = $("triAngleC").value;

    const tickB = $("triTickBottom").checked;
    const tickL = $("triTickLeft").checked;
    const tickR = $("triTickRight").checked;
    const showSideLabels = $("triShowSideLabels").checked;
    const showAngleLabels = $("triShowAngleLabels").checked;

    // Font size is driven directly by the slider; the rest scale proportionally from it
    // (calibrated so slider=24 matches the old "off" state and slider=36 matches the old "large" state).
    const sideFontSize = parseInt($("triFontSize").value) || 24;
    const scaleT = sideFontSize - 24;
    const angleFontSize = Math.round(22 + scaleT * (10 / 12));
    const sideOffsetDist = Math.round(32 + scaleT * (14 / 12));
    const sideVertAdjust = Math.round(7 + scaleT * (4 / 12));
    const angleOffsetDist = Math.round(47 + scaleT * (15 / 12));

    let A = { x: 160, y: 320 }, B = { x: 0, y: 0 }, C = { x: 340, y: 320 };
    // Is vertex B actually free to be dragged? A right angle pins it, and three numeric sides
    // construct it by SSS. Offering a handle in either case would be a lie — it would move and
    // then snap straight back.
    let bIsFree = false;
    if (isRight) {
      C.x = A.x + 180; C.y = A.y;
      B.x = A.x; B.y = A.y - 140;
      // If both legs are given as plain numbers, draw the triangle at their true relative proportions.
      const parsedLegs = tryParseDims([lblBottom, lblLeft]);
      if (parsedLegs) {
        const [bottomPx, leftPx] = scaleToPixels(parsedLegs, 16, 80, 280);
        C.x = A.x + bottomPx; C.y = A.y;
        B.x = A.x; B.y = A.y - leftPx;
      }
    } else {
      B.x = parseInt($("triVertexBX").value) || 250;
      B.y = parseInt($("triVertexBY").value) || 130;
      bIsFree = true;
      // If all three sides are given as plain numbers (and form a valid triangle), construct the
      // true SSS shape via the law of cosines instead of using the arbitrary vertex-B position.
      const parsedSSS = tryParseDims([lblBottom, lblLeft, lblRight]);
      if (parsedSSS) {
        const [bottomU, leftU, rightU] = parsedSSS;
        if (bottomU + leftU > rightU && bottomU + rightU > leftU && leftU + rightU > bottomU) {
          const [bottomPx, leftPx, rightPx] = scaleToPixels(parsedSSS, 16, 80, 280);
          const cosA = (leftPx * leftPx + bottomPx * bottomPx - rightPx * rightPx) / (2 * leftPx * bottomPx);
          const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
          A = { x: 160, y: 320 };
          C = { x: 160 + bottomPx, y: 320 };
          B = { x: A.x + leftPx * Math.cos(angleA), y: A.y - leftPx * Math.sin(angleA) };
          bIsFree = false;
        }
      }
    }
    const bRaw = { x: B.x, y: B.y }; // pre-centring, which is the space the two fields live in

    const canvasCenter = { x: 250, y: 250 };
    const rawCentroid = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
    const shiftX = canvasCenter.x - rawCentroid.x;
    const shiftY = canvasCenter.y - rawCentroid.y;
    A.x += shiftX; A.y += shiftY; B.x += shiftX; B.y += shiftY; C.x += shiftX; C.y += shiftY;

    const rotA = rotatePoint(A, canvasCenter, rotationDeg);
    const rotB = rotatePoint(B, canvasCenter, rotationDeg);
    const rotC = rotatePoint(C, canvasCenter, rotationDeg);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    trackBB(rotA.x, rotA.y); trackBB(rotB.x, rotB.y); trackBB(rotC.x, rotC.y);

    let innerSvg = `  <!-- Geometry Outline -->\n`;
    innerSvg += `  <polygon points="${rotA.x},${rotA.y} ${rotB.x},${rotB.y} ${rotC.x},${rotC.y}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    if (isRight) {
      const rSize = 18;
      let abX = rotB.x - rotA.x, abY = rotB.y - rotA.y;
      let acX = rotC.x - rotA.x, acY = rotC.y - rotA.y;
      let lenAB = Math.sqrt(abX*abX + abY*abY) || 1;
      let lenAC = Math.sqrt(acX*acX + acY*acY) || 1;
      let uAB = { x: abX/lenAB, y: abY/lenAB }, uAC = { x: acX/lenAC, y: acY/lenAC };
      let p1 = { x: rotA.x + uAB.x * rSize, y: rotA.y + uAB.y * rSize };
      let p3 = { x: rotA.x + uAC.x * rSize, y: rotA.y + uAC.y * rSize };
      let p2 = { x: p1.x + uAC.x * rSize, y: p1.y + uAC.y * rSize };
      innerSvg += `  <path d="M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
      trackBB(p1.x, p1.y); trackBB(p2.x, p2.y); trackBB(p3.x, p3.y);
    }

    /* Drag targets. Vertex B was the worst offender in the whole dialog: two number fields asking
       for raw SVG pixel coordinates ("Non-Right Vertex B (X): 250") for a point sitting right there
       on screen.

       Inverting the forward transform is the whole job, and it is done here because this is where
       that transform was written. Two steps: undo the rotation about canvasCenter, then undo the
       centring shift. The shift is the subtle one — the shape is re-centred on its centroid every
       render, so moving B by d moves the DRAWN vertex by only (2/3)d, the other third being the
       centroid chasing it. Hence the 1.5. Working in deltas from the current position also means
       the handle stays exactly under the pointer instead of jumping on grab. */
    if (bIsFree) {
      handles.push({
        cx: rotB.x, cy: rotB.y, kind: "vertex", title: "Drag to move this corner",
        apply: pt => {
          const un = rotatePoint(pt, canvasCenter, -rotationDeg);
          return {
            triVertexBX: Math.round(bRaw.x + (un.x - B.x) * 1.5),
            triVertexBY: Math.round(bRaw.y + (un.y - B.y) * 1.5),
          };
        },
      });
    }
    // Radius is measured from the centre the shape rotates about, so it doesn't itself change as
    // you rotate — the handle sweeps a circle rather than wandering.
    const maxVertexDist = Math.max(90,
      Math.hypot(rotA.x - canvasCenter.x, rotA.y - canvasCenter.y),
      Math.hypot(rotB.x - canvasCenter.x, rotB.y - canvasCenter.y),
      Math.hypot(rotC.x - canvasCenter.x, rotC.y - canvasCenter.y));
    const rotR = 34 + maxVertexDist;
    const rotRad = (rotationDeg - 90) * Math.PI / 180;
    const rotGripX = canvasCenter.x + rotR * Math.cos(rotRad);
    const rotGripY = canvasCenter.y + rotR * Math.sin(rotRad);
    /* Reserve a square centred on the pivot, big enough for everything drawn, so the view can't
       change as the shape turns.

       Without this the crop hugs the rotated shape and its aspect flips through a turn — measured,
       the pivot slid ~100px across the stage between 0° and 90°. Since the pointer is stationary in
       screen space while the reference point moves, a drag ended up as much as 47° from where it
       was dropped, which makes rotating by hand nearly useless.

       Every term below is a distance from the pivot, and rotation preserves those, so the square is
       identical at every angle. It is applied at rest too, not just mid-drag: switching to it on
       pointerdown would make the grip jump out from under the pointer at the moment of grabbing it.
       The cost is that the shape draws about 13% smaller than a tight crop would allow. */
    const stableR = Math.max(
      maxVertexDist + sideOffsetDist + 24,  // side labels sit outside the edges
      maxVertexDist + angleOffsetDist + 24, // angle labels are offset from the corners
      rotR + 24 + 38,                       // the readout sits 24 past the grip and reaches 38 more
    );
    handles.push({
      cx: rotGripX, cy: rotGripY, kind: "rotate", title: "Drag to rotate",
      stable: { cx: canvasCenter.x, cy: canvasCenter.y, r: stableR },
      apply: pt => {
        const raw = Math.atan2(pt.y - canvasCenter.y, pt.x - canvasCenter.x) * 180 / Math.PI + 90;
        const deg = (raw % 360 + 360) % 360;
        // Magnetic snap to the nearest 15°, but only within 4° of one. That's what makes an exact
        // 90° easy by hand — which is the job the four preset buttons used to do — while leaving
        // genuinely odd angles (37°, 52°) reachable, which those buttons never allowed.
        const near = Math.round(deg / 15) * 15;
        return { triRotation: Math.abs(deg - near) <= 4 ? (near % 360) : Math.round(deg) };
      },
    });
    // The rotation's value, shown on the shape next to its grip and editable by clicking it. This
    // is the whole replacement for the slider + 0/90/180/270 buttons: drag for coarse, snap for the
    // right angles, click the number when you want an exact one typed.
    hotspots.push({
      cx: canvasCenter.x + (rotR + 24) * Math.cos(rotRad),
      cy: canvasCenter.y + (rotR + 24) * Math.sin(rotRad),
      w: 44, h: 20, field: "triRotation", title: "rotation", text: `${Math.round(rotationDeg)}°`, fontSize: 13,
    });

    function processSide(pStart, pEnd, labelText, drawTick, field) {
      let mx = (pStart.x + pEnd.x) / 2, my = (pStart.y + pEnd.y) / 2;
      let dx = pEnd.x - pStart.x, dy = pEnd.y - pStart.y;
      let len = Math.sqrt(dx*dx + dy*dy) || 1;
      let nx = -dy / len, ny = dx / len;
      let cx = mx - canvasCenter.x, cy = my - canvasCenter.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      if (drawTick) {
        const tLen = 9;
        const tx1 = mx - nx * tLen, ty1 = my - ny * tLen, tx2 = mx + nx * tLen, ty2 = my + ny * tLen;
        innerSvg += `  <line x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="black" stroke-width="2"/>\n`;
        trackBB(tx1, ty1); trackBB(tx2, ty2);
      }
      if (labelText && showSideLabels) {
        labelSpecs.push({ x: mx + nx * sideOffsetDist, y: my + ny * sideOffsetDist + sideVertAdjust, text: labelText, fontSize: +sideFontSize, field });
      }
      // An empty side still gets a click target, at the spot the label would occupy — otherwise
      // the only way to fill in a blank side is back in the form column.
      if (!labelText && showSideLabels && field) {
        hotspots.push({ cx: mx + nx * sideOffsetDist, cy: my + ny * sideOffsetDist, w: 46, h: sideFontSize + 12, field, title: "this side", placeholder: true });
      }
    }

    processSide(rotA, rotC, lblBottom, tickB, "triBottom");
    processSide(rotA, rotB, lblLeft, tickL, "triLeft");
    processSide(rotB, rotC, lblRight, tickR, "triRight");

    /* An empty angle draws nothing at all, so without this there'd be no way to add one now that
       the three text fields are gone — an invisible click target you have to guess at is not an
       affordance. A faint outline sits at each unlabelled corner instead. */
    const anglePlaceholder = (vertex, p1, p2, field, skip) => {
      if (skip || !showAngleLabels) return;
      const pos = getBisectorVector(vertex, p1, p2, angleOffsetDist, canvasCenter);
      hotspots.push({ cx: pos.x, cy: pos.y, w: 34, h: angleFontSize + 8, field, title: "this angle", placeholder: true });
    };
    anglePlaceholder(rotA, rotB, rotC, "triAngleA", isRight || !!txtAngleA);
    anglePlaceholder(rotB, rotA, rotC, "triAngleB", !!txtAngleB);
    anglePlaceholder(rotC, rotA, rotB, "triAngleC", !!txtAngleC);

    if (txtAngleA && !isRight) {
      innerSvg += drawAngleArc(rotA, rotB, rotC, 26, canvasCenter);
      trackBB(rotA.x - 26, rotA.y - 26); trackBB(rotA.x + 26, rotA.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotA, rotB, rotC, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleA, fontSize: +angleFontSize, field: "triAngleA" });
      }
    }
    if (txtAngleB) {
      innerSvg += drawAngleArc(rotB, rotA, rotC, 26, canvasCenter);
      trackBB(rotB.x - 26, rotB.y - 26); trackBB(rotB.x + 26, rotB.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotB, rotA, rotC, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleB, fontSize: +angleFontSize, field: "triAngleB" });
      }
    }
    if (txtAngleC) {
      innerSvg += drawAngleArc(rotC, rotA, rotB, 26, canvasCenter);
      trackBB(rotC.x - 26, rotC.y - 26); trackBB(rotC.x + 26, rotC.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotC, rotA, rotB, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleC, fontSize: +angleFontSize, field: "triAngleC" });
      }
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "circle") {
    const lblRadius = $("circRadius").value;
    const showRadius = $("circShowRadius").checked;
    const showDiameter = $("circShowDiameter").checked;
    const lblDiameter = $("circDiameter").value;
    const sectorAngle = Math.max(0, Math.min(360, parseFloat($("circSectorAngle").value) || 0));
    const lblSector = $("circSectorLabel").value;
    const fontSize = parseInt($("circFontSize").value) || 24;
    const showSideLabels = $("circShowSideLabels").checked;
    const showAngleLabels = $("circShowAngleLabels").checked;

    const center = { x: 250, y: 250 };
    let R = 150;
    const parsedR = tryParseDims([lblRadius]);
    if (parsedR) [R] = scaleToPixels(parsedR, 20, 60, 200);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    trackBB(center.x - R, center.y - R); trackBB(center.x + R, center.y + R);

    let innerSvg = `  <circle cx="${center.x}" cy="${center.y}" r="${R}" fill="none" stroke="black" stroke-width="2.5"/>\n`;

    if (sectorAngle > 0) {
      const rad = sectorAngle * Math.PI / 180;
      const p1 = { x: center.x + R, y: center.y };
      const p2 = { x: center.x + R * Math.cos(rad), y: center.y + R * Math.sin(rad) };
      const largeArc = sectorAngle > 180 ? 1 : 0;
      innerSvg += `  <path d="M ${center.x} ${center.y} L ${p1.x} ${p1.y} A ${R} ${R} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z" fill="rgba(15,118,110,0.12)" stroke="black" stroke-width="2"/>\n`;
      if (lblSector && showAngleLabels) {
        const midRad = rad / 2, labelDist = R * 0.55;
        labelSpecs.push({
          x: center.x + labelDist * Math.cos(midRad), y: center.y + labelDist * Math.sin(midRad),
          text: lblSector, fontSize: Math.round(fontSize * 0.9),
        });
      }
    }

    // Radius line — placed away from the sector (if any) so labels don't collide.
    const radiusAngleDeg = sectorAngle > 0 ? sectorAngle + 55 : -20;
    const radRad = radiusAngleDeg * Math.PI / 180;
    if (showRadius) {
      const rEnd = { x: center.x + R * Math.cos(radRad), y: center.y + R * Math.sin(radRad) };
      innerSvg += `  <line x1="${center.x}" y1="${center.y}" x2="${rEnd.x}" y2="${rEnd.y}" stroke="black" stroke-width="2"/>\n`;
      trackBB(rEnd.x, rEnd.y);
      if (lblRadius && showSideLabels) {
        // Sits right on the line itself (partway out from center), not offset to one side of it —
        // reads as labeling the line instead of floating near it inside the circle.
        const t = 0.55;
        labelSpecs.push({
          x: center.x + R * t * Math.cos(radRad), y: center.y + R * t * Math.sin(radRad),
          text: lblRadius, fontSize,
        });
      }
    }

    if (showDiameter) {
      const diamAngleDeg = radiusAngleDeg + 90;
      const dr = diamAngleDeg * Math.PI / 180;
      const d1 = { x: center.x + R * Math.cos(dr), y: center.y + R * Math.sin(dr) };
      const d2 = { x: center.x - R * Math.cos(dr), y: center.y - R * Math.sin(dr) };
      innerSvg += `  <line x1="${d1.x}" y1="${d1.y}" x2="${d2.x}" y2="${d2.y}" stroke="black" stroke-width="2"/>\n`;
      trackBB(d1.x, d1.y); trackBB(d2.x, d2.y);
      if (lblDiameter && showSideLabels) {
        const t = 0.55;
        labelSpecs.push({
          x: center.x + R * t * Math.cos(dr), y: center.y + R * t * Math.sin(dr),
          text: lblDiameter, fontSize,
        });
      }
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "square" || type === "rectangle" || type === "parallelogram") {
    const fontSize = parseInt($("quadFontSize").value) || 24;
    const rotationDeg = parseFloat($("quadRotation").value) || 0;
    const center = { x: 250, y: 250 };

    let A, B, C, D;
    const sideLabels = []; // {p1, p2, text}
    const tickSides = [];  // [p1, p2] pairs to mark with a tick
    let rightAngleCorners = []; // {corner, adjA, adjB}
    let angleLabel = null; // {corner, adjA, adjB, text}
    const showSideLabels = type === "square" ? $("quadSquareShowLabels").checked
      : type === "rectangle" ? $("quadRectShowLabels").checked
      : $("quadParaShowSideLabels").checked;
    const showAngleLabels = type === "parallelogram" ? $("quadParaShowAngleLabels").checked : true;

    if (type === "square") {
      const sideVal = $("quadSquareSide").value;
      let s = 200;
      const parsed = tryParseDims([sideVal]);
      if (parsed) [s] = scaleToPixels(parsed, 18, 80, 300);
      A = { x: 150, y: 150 + s }; B = { x: 150, y: 150 }; C = { x: 150 + s, y: 150 }; D = { x: 150 + s, y: 150 + s };
      if (sideVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: sideVal });
      if ($("quadSquareTicks").checked) tickSides.push([A, D], [D, C], [C, B], [B, A]);
      if ($("quadSquareRight").checked) rightAngleCorners = [
        { corner: A, adjA: B, adjB: D }, { corner: B, adjA: C, adjB: A },
        { corner: C, adjA: D, adjB: B }, { corner: D, adjA: A, adjB: C },
      ];
    } else if (type === "rectangle") {
      const wVal = $("quadRectWidth").value, hVal = $("quadRectHeight").value;
      let w = 260, h = 180;
      const parsed = tryParseDims([wVal, hVal]);
      if (parsed) [w, h] = scaleToPixels(parsed, 18, 80, 320);
      A = { x: 120, y: 160 + h }; B = { x: 120, y: 160 }; C = { x: 120 + w, y: 160 }; D = { x: 120 + w, y: 160 + h };
      if (wVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: wVal });
      if (hVal && showSideLabels) sideLabels.push({ p1: A, p2: B, text: hVal });
      if ($("quadRectRight").checked) rightAngleCorners = [
        { corner: A, adjA: B, adjB: D }, { corner: B, adjA: C, adjB: A },
        { corner: C, adjA: D, adjB: B }, { corner: D, adjA: A, adjB: C },
      ];
    } else {
      const paraAngleDeg = parseFloat($("quadParaAngle").value) || 60;
      const angleRad = paraAngleDeg * Math.PI / 180;
      const baseVal = $("quadParaBase").value, sideVal = $("quadParaSide").value;
      let baseLen = 220, sideLen = 170;
      const parsed = tryParseDims([baseVal, sideVal]);
      if (parsed) [baseLen, sideLen] = scaleToPixels(parsed, 18, 80, 300);
      A = { x: 150, y: 350 };
      D = { x: 150 + baseLen, y: 350 };
      B = { x: A.x + sideLen * Math.cos(angleRad), y: A.y - sideLen * Math.sin(angleRad) };
      C = { x: D.x + sideLen * Math.cos(angleRad), y: D.y - sideLen * Math.sin(angleRad) };
      if (baseVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: baseVal });
      if (sideVal && showSideLabels) sideLabels.push({ p1: A, p2: B, text: sideVal });
      if (showAngleLabels) angleLabel = { corner: A, adjA: D, adjB: B, text: Math.round(paraAngleDeg) + "°" };
    }

    const verts = [A, B, C, D];
    const rawCentroid = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
    const shiftX = center.x - rawCentroid.x, shiftY = center.y - rawCentroid.y;
    verts.forEach(v => { v.x += shiftX; v.y += shiftY; });

    const rot = v => rotatePoint(v, center, rotationDeg);
    const rA = rot(A), rB = rot(B), rC = rot(C), rD = rot(D);
    const rotMap = new Map([[A, rA], [B, rB], [C, rC], [D, rD]]);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    [rA, rB, rC, rD].forEach(p => trackBB(p.x, p.y));

    let innerSvg = `  <polygon points="${rA.x},${rA.y} ${rB.x},${rB.y} ${rC.x},${rC.y} ${rD.x},${rD.y}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    for (const [p1, p2] of tickSides) {
      const rp1 = rotMap.get(p1), rp2 = rotMap.get(p2);
      const mx = (rp1.x + rp2.x) / 2, my = (rp1.y + rp2.y) / 2;
      const dx = rp2.x - rp1.x, dy = rp2.y - rp1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len, ny = dx / len, tLen = 9;
      innerSvg += `  <line x1="${mx - nx * tLen}" y1="${my - ny * tLen}" x2="${mx + nx * tLen}" y2="${my + ny * tLen}" stroke="black" stroke-width="2"/>\n`;
    }

    for (const { corner, adjA, adjB } of rightAngleCorners) {
      const rc = rotMap.get(corner), ra = rotMap.get(adjA), rb = rotMap.get(adjB);
      const rSize = 16;
      let uA = { x: ra.x - rc.x, y: ra.y - rc.y }, uB = { x: rb.x - rc.x, y: rb.y - rc.y };
      const lenA = Math.sqrt(uA.x ** 2 + uA.y ** 2) || 1, lenB = Math.sqrt(uB.x ** 2 + uB.y ** 2) || 1;
      uA = { x: uA.x / lenA, y: uA.y / lenA }; uB = { x: uB.x / lenB, y: uB.y / lenB };
      const p1 = { x: rc.x + uA.x * rSize, y: rc.y + uA.y * rSize };
      const p3 = { x: rc.x + uB.x * rSize, y: rc.y + uB.y * rSize };
      const p2 = { x: p1.x + uB.x * rSize, y: p1.y + uB.y * rSize };
      innerSvg += `  <path d="M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
    }

    for (const { p1, p2, text } of sideLabels) {
      const rp1 = rotMap.get(p1), rp2 = rotMap.get(p2);
      const mx = (rp1.x + rp2.x) / 2, my = (rp1.y + rp2.y) / 2;
      const dx = rp2.x - rp1.x, dy = rp2.y - rp1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const cx = mx - center.x, cy = my - center.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      const offsetDist = 32;
      labelSpecs.push({ x: mx + nx * offsetDist, y: my + ny * offsetDist, text, fontSize });
    }

    if (angleLabel) {
      const rc = rotMap.get(angleLabel.corner), ra = rotMap.get(angleLabel.adjA), rb = rotMap.get(angleLabel.adjB);
      innerSvg += drawAngleArc(rc, ra, rb, 26, center);
      trackBB(rc.x - 26, rc.y - 26); trackBB(rc.x + 26, rc.y + 26);
      const pos = getBisectorVector(rc, ra, rb, 47, center);
      labelSpecs.push({ x: pos.x, y: pos.y, text: angleLabel.text, fontSize: Math.round(fontSize * 0.9) });
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "polygon") {
    const n = Math.max(3, Math.min(12, parseInt($("polygonSides").value) || 6));
    const fontSize = parseInt($("polygonFontSize").value) || 24;
    const rotationDeg = parseFloat($("polygonRotation").value) || 0;
    const sideVal = $("polygonSide").value;
    const showAngle = $("polygonShowAngle").checked;
    const center = { x: 250, y: 250 };
    let R = 150;
    const parsedSide = tryParseDims([sideVal]);
    if (parsedSide) {
      const [sidePx] = scaleToPixels(parsedSide, 18, 40, 150);
      R = Math.max(50, Math.min(220, sidePx / (2 * Math.sin(Math.PI / n))));
    }

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }

    const verts = [];
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + i * (2 * Math.PI / n) + rotationDeg * Math.PI / 180;
      verts.push({ x: center.x + R * Math.cos(angle), y: center.y + R * Math.sin(angle) });
    }
    verts.forEach(v => trackBB(v.x, v.y));

    let innerSvg = `  <polygon points="${verts.map(v => `${v.x},${v.y}`).join(" ")}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    if (sideVal && $("polygonShowSideLabels").checked) {
      const p1 = verts[0], p2 = verts[1];
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const cx = mx - center.x, cy = my - center.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      labelSpecs.push({ x: mx + nx * 28, y: my + ny * 28, text: sideVal, fontSize });
    }

    if (showAngle) {
      const interiorDeg = Math.round((n - 2) * 180 / n);
      const v0 = verts[0], prev = verts[n - 1], next = verts[1];
      innerSvg += drawAngleArc(v0, prev, next, 22, center);
      trackBB(v0.x - 22, v0.y - 22); trackBB(v0.x + 22, v0.y + 22);
      const pos = getBisectorVector(v0, prev, next, 40, center);
      labelSpecs.push({ x: pos.x, y: pos.y, text: interiorDeg + "°", fontSize: Math.round(fontSize * 0.85) });
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cube" || type === "prism") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    let W, H, Dd, lblW, lblH, lblD;
    if (type === "cube") {
      const sideVal = $("cubeSide").value;
      W = H = 160; Dd = 96;
      const parsed = tryParseDims([sideVal]);
      if (parsed) { const [s] = scaleToPixels(parsed, 16, 70, 240); W = H = s; Dd = s * 0.6; }
      lblW = lblH = lblD = sideVal;
    } else {
      const wVal = $("prismWidth").value, hVal = $("prismHeight").value, dVal = $("prismDepth").value;
      W = 220; H = 150; Dd = 130;
      const parsed = tryParseDims([wVal, hVal, dVal]);
      if (parsed) [W, H, Dd] = scaleToPixels(parsed, 16, 70, 240);
      lblW = wVal; lblH = hVal; lblD = dVal;
    }
    const depthAngle = (parseFloat($("solid3dDepthAngle").value) || 35) * Math.PI / 180;
    const dvx = Dd * Math.cos(depthAngle), dvy = -Dd * Math.sin(depthAngle);

    const FTL = { x: 0, y: 0 }, FTR = { x: W, y: 0 }, FBR = { x: W, y: H }, FBL = { x: 0, y: H };
    const BTL = { x: FTL.x + dvx, y: FTL.y + dvy }, BTR = { x: FTR.x + dvx, y: FTR.y + dvy };
    const BBR = { x: FBR.x + dvx, y: FBR.y + dvy }, BBL = { x: FBL.x + dvx, y: FBL.y + dvy };

    const allPts = [FTL, FTR, FBR, FBL, BTL, BTR, BBR, BBL];
    const cx0 = allPts.reduce((a, p) => a + p.x, 0) / allPts.length;
    const cy0 = allPts.reduce((a, p) => a + p.y, 0) / allPts.length;
    const shiftX = 250 - cx0, shiftY = 250 - cy0;
    allPts.forEach(p => { p.x += shiftX; p.y += shiftY; });

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    allPts.forEach(p => trackBB(p.x, p.y));

    const solidEdges = [[FTL, FTR], [FTR, FBR], [FBR, FBL], [FBL, FTL], [FTL, BTL], [FTR, BTR], [FBR, BBR], [BTL, BTR], [BTR, BBR]];
    const hiddenEdges = [[FBL, BBL], [BBL, BTL], [BBL, BBR]];
    let innerSvg = "";
    for (const [p1, p2] of solidEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="2.2"/>\n`;
    for (const [p1, p2] of hiddenEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;

    const showLabels3d = (type === "cube" ? $("cubeShowLabels") : $("prismShowLabels")).checked;
    if (lblW && showLabels3d) { const mx = (FBL.x + FBR.x) / 2, my = (FBL.y + FBR.y) / 2; labelSpecs.push({ x: mx, y: my + 26, text: lblW, fontSize }); }
    if (lblH && showLabels3d) { const mx = (FTL.x + FBL.x) / 2, my = (FTL.y + FBL.y) / 2; labelSpecs.push({ x: mx - 32, y: my, text: lblH, fontSize }); }
    if (lblD && showLabels3d) { const p = labelOffEdge(FTR, BTR, { x: 250, y: 250 }, 20); labelSpecs.push({ x: p.x, y: p.y, text: lblD, fontSize }); }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "pyramid") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblWidth = $("pyramidWidth").value, lblDepth = $("pyramidDepth").value, lblHeight = $("pyramidHeight").value;
    let baseLen = 210, Dd = 147, heightPx = 180;
    const parsedPyr = tryParseDims([lblWidth, lblDepth, lblHeight]);
    if (parsedPyr) [baseLen, Dd, heightPx] = scaleToPixels(parsedPyr, 16, 70, 240);
    const depthAngle = (parseFloat($("solid3dDepthAngle").value) || 35) * Math.PI / 180;
    const dvx = Dd * Math.cos(depthAngle), dvy = -Dd * Math.sin(depthAngle);

    const FBL = { x: 0, y: 0 }, FBR = { x: baseLen, y: 0 };
    const BBL = { x: FBL.x + dvx, y: FBL.y + dvy }, BBR = { x: FBR.x + dvx, y: FBR.y + dvy };
    const baseCenter = { x: (FBL.x + FBR.x + BBL.x + BBR.x) / 4, y: (FBL.y + FBR.y + BBL.y + BBR.y) / 4 };
    const apex = { x: baseCenter.x, y: baseCenter.y - heightPx };

    const allPts = [FBL, FBR, BBL, BBR, apex];
    const cx0 = allPts.reduce((a, p) => a + p.x, 0) / allPts.length;
    const cy0 = allPts.reduce((a, p) => a + p.y, 0) / allPts.length;
    const shiftX = 250 - cx0, shiftY = 250 - cy0;
    allPts.forEach(p => { p.x += shiftX; p.y += shiftY; });
    baseCenter.x += shiftX; baseCenter.y += shiftY;

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    allPts.forEach(p => trackBB(p.x, p.y));

    const solidEdges = [[FBL, FBR], [FBR, BBR], [FBR, apex], [FBL, apex], [BBR, apex]];
    const hiddenEdges = [[BBL, BBR], [BBL, FBL], [BBL, apex]];
    let innerSvg = "";
    for (const [p1, p2] of solidEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="2.2"/>\n`;
    for (const [p1, p2] of hiddenEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    const showHeightPyr = $("pyramidShowHeight").checked;
    if (showHeightPyr) innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${baseCenter.x}" y2="${baseCenter.y}" stroke="black" stroke-width="1.2" stroke-dasharray="4,3"/>\n`;

    const showLabelsPyr = $("pyramidShowLabels").checked;
    if (lblWidth && showLabelsPyr) { const mx = (FBL.x + FBR.x) / 2, my = (FBL.y + FBR.y) / 2; labelSpecs.push({ x: mx, y: my + 26, text: lblWidth, fontSize }); }
    if (lblDepth && showLabelsPyr) { const p = labelOffEdge(FBR, BBR, { x: 250, y: 250 }, 18); labelSpecs.push({ x: p.x, y: p.y, text: lblDepth, fontSize }); }
    // Placed on the left of the dashed height line, two-thirds of the way down, where the pyramid
    // is widest and the apex's rightward depth-offset leaves the least room on the right side —
    // this keeps long label text clear of both slant edges instead of sitting on top of one.
    if (showHeightPyr && lblHeight && showLabelsPyr) { labelSpecs.push({ x: apex.x - 45, y: apex.y + 0.62 * (baseCenter.y - apex.y), text: lblHeight, fontSize }); }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cylinder") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblR = $("cylRadius").value, lblH = $("cylHeight").value;
    const showRadiusCyl = $("cylShowRadius").checked;
    const showDiameterCyl = $("cylShowDiameter").checked, lblDiameterCyl = $("cylDiameter").value;
    let rx = 120, heightPx = 180;
    const parsedCyl = tryParseDims([lblR, lblH]);
    if (parsedCyl) [rx, heightPx] = scaleToPixels(parsedCyl, 16, 50, 200);
    const ry = rx * ((parseFloat($("solid3dPerspective").value) || 33) / 100);
    const topCenter = { x: 250, y: 250 - heightPx / 2 };
    const botCenter = { x: 250, y: 250 + heightPx / 2 };

    let innerSvg = `  <ellipse cx="${topCenter.x}" cy="${topCenter.y}" rx="${rx}" ry="${ry}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${botCenter.x - rx} ${botCenter.y} A ${rx} ${ry} 0 0 0 ${botCenter.x + rx} ${botCenter.y}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${botCenter.x - rx} ${botCenter.y} A ${rx} ${ry} 0 0 1 ${botCenter.x + rx} ${botCenter.y}" fill="none" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    innerSvg += `  <line x1="${topCenter.x - rx}" y1="${topCenter.y}" x2="${botCenter.x - rx}" y2="${botCenter.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <line x1="${topCenter.x + rx}" y1="${topCenter.y}" x2="${botCenter.x + rx}" y2="${botCenter.y}" stroke="black" stroke-width="2.5"/>\n`;

    // The radius (and optional diameter) indicator line's label depends on showLabelsCyl, but
    // whether the LINE itself is drawn at all is a separate toggle (showRadiusCyl/showDiameterCyl).
    const showLabelsCyl = $("cylShowLabels").checked;
    if (showRadiusCyl) {
      innerSvg += `  <line x1="${topCenter.x}" y1="${topCenter.y}" x2="${topCenter.x + rx}" y2="${topCenter.y}" stroke="black" stroke-width="1.8"/>\n`;
      if (lblR && showLabelsCyl) labelSpecs.push({ x: topCenter.x + rx / 2, y: topCenter.y - 14, text: lblR, fontSize });
    }
    if (lblH && showLabelsCyl) labelSpecs.push({ x: topCenter.x + rx + 22, y: (topCenter.y + botCenter.y) / 2, text: lblH, fontSize });

    if (showDiameterCyl) {
      innerSvg += `  <line x1="${topCenter.x - rx}" y1="${topCenter.y}" x2="${topCenter.x + rx}" y2="${topCenter.y}" stroke="black" stroke-width="1.8"/>\n`;
      // Placed above the ellipse (not alongside the radius label) so long label text never collides
      // with the radius label regardless of string length.
      if (lblDiameterCyl && showLabelsCyl) labelSpecs.push({ x: topCenter.x, y: topCenter.y - ry - fontSize * 0.6 - 10, text: lblDiameterCyl, fontSize });
    }

    const cropMargin = 16;
    const boxX = Math.floor(topCenter.x - rx - cropMargin), boxY = Math.floor(topCenter.y - ry - cropMargin);
    const boxW = Math.ceil((rx * 2)) + cropMargin * 2, boxH = Math.ceil(botCenter.y + ry - (topCenter.y - ry)) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cone") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblR = $("coneRadius").value, lblH = $("coneHeight").value;
    const showRadiusCone = $("coneShowRadius").checked;
    const showSlant = $("coneShowSlant").checked, lblSlant = $("coneSlant").value;
    let rx = 120, heightPx = 190;
    const parsedCone = tryParseDims([lblR, lblH]);
    if (parsedCone) [rx, heightPx] = scaleToPixels(parsedCone, 16, 50, 200);
    const ry = rx * ((parseFloat($("solid3dPerspective").value) || 33) / 100);
    const apex = { x: 250, y: 250 - heightPx / 2 };
    const baseCenter = { x: 250, y: 250 + heightPx / 2 };
    const leftPt = { x: baseCenter.x - rx, y: baseCenter.y };
    const rightPt = { x: baseCenter.x + rx, y: baseCenter.y };

    let innerSvg = `  <line x1="${apex.x}" y1="${apex.y}" x2="${leftPt.x}" y2="${leftPt.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${rightPt.x}" y2="${rightPt.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${leftPt.x} ${leftPt.y} A ${rx} ${ry} 0 0 0 ${rightPt.x} ${rightPt.y}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${leftPt.x} ${leftPt.y} A ${rx} ${ry} 0 0 1 ${rightPt.x} ${rightPt.y}" fill="none" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    const showHeightCone = $("coneShowHeight").checked;
    if (showHeightCone) innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${baseCenter.x}" y2="${baseCenter.y}" stroke="black" stroke-width="1.2" stroke-dasharray="4,3"/>\n`;

    // Indicator lines' labels depend on showLabelsCone, but whether the radius LINE itself is
    // drawn at all is a separate toggle (showRadiusCone).
    const showLabelsCone = $("coneShowLabels").checked;
    if (showRadiusCone) {
      innerSvg += `  <line x1="${baseCenter.x}" y1="${baseCenter.y}" x2="${rightPt.x}" y2="${rightPt.y}" stroke="black" stroke-width="1.8"/>\n`;
      // r sits above its line (not below, where it would cross the base ellipse's front curve).
      if (lblR && showLabelsCone) labelSpecs.push({ x: (baseCenter.x + rightPt.x) / 2, y: baseCenter.y - 14, text: lblR, fontSize });
    }
    // h and the slant label are staggered at different heights/sides along their own lines so
    // long label text never collides, instead of both landing at the same mid-height row.
    if (showHeightCone && lblH && showLabelsCone) labelSpecs.push({ x: apex.x - 30, y: apex.y + 0.4 * heightPx, text: lblH, fontSize });
    if (showSlant && lblSlant && showLabelsCone) {
      // Placed perpendicular-outward from the slant line's own midpoint (the same convention used
      // for triangle/quadrilateral side labels) rather than a fixed fraction/offset along the line —
      // for a short, wide cone a fixed fraction can land close enough to the radius label below it
      // to collide; an outward normal from the midpoint keeps consistent clearance from both
      // neighbors regardless of the cone's proportions.
      const mx = (apex.x + rightPt.x) / 2, my = (apex.y + rightPt.y) / 2;
      const dx = rightPt.x - apex.x, dy = rightPt.y - apex.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const coneCenter = { x: apex.x, y: (apex.y + baseCenter.y) / 2 };
      if (nx * (mx - coneCenter.x) + ny * (my - coneCenter.y) < 0) { nx = -nx; ny = -ny; }
      labelSpecs.push({ x: mx + nx * 20, y: my + ny * 20, text: lblSlant, fontSize });
    }

    const cropMargin = 16;
    const boxX = Math.floor(leftPt.x - cropMargin), boxY = Math.floor(apex.y - cropMargin);
    const boxW = Math.ceil(rightPt.x - leftPt.x) + cropMargin * 2, boxH = Math.ceil((baseCenter.y + ry) - apex.y) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "numberline") {
    const fontSize = parseInt($("nlFontSize").value) || 20;
    let minV = parseFloat($("nlMin").value), maxV = parseFloat($("nlMax").value);
    if (!Number.isFinite(minV)) minV = -4;
    if (!Number.isFinite(maxV)) maxV = 4;
    if (maxV <= minV) maxV = minV + 1;
    let step = Math.max(0.0001, parseFloat($("nlStep").value) || 1);
    const hlFromStr = $("nlHlFrom").value, hlToStr = $("nlHlTo").value;
    const hlFrom = hlFromStr === "" ? null : parseFloat(hlFromStr);
    const hlTo = hlToStr === "" ? null : parseFloat(hlToStr);
    const fromMode = $("nlFromCircle").value, toMode = $("nlToCircle").value;
    const fromOpen = fromMode === "open", toOpen = toMode === "open";
    const fromEnd = fromMode === "end", toEnd = toMode === "end";
    const showLabelsNl = $("nlShowLabels").checked;
    const showArrowsNl = $("nlArrows").checked;

    const pad = 50, lineY = 250, usableW = 500 - pad * 2;
    const mapX = v => pad + ((v - minV) / (maxV - minV)) * usableW;

    // Arrows extend a bit past the last labeled tick, as on a traditionally drawn number line.
    const arrowExt = Math.min(30, Math.max(15, usableW * 0.06));
    const x0 = mapX(minV) - arrowExt, x1e = mapX(maxV) + arrowExt;

    let innerSvg = "";

    let hlLeftX = null, hlRightX = null;
    if (fromEnd) hlLeftX = x0;
    else if (hlFrom != null && Number.isFinite(hlFrom)) hlLeftX = mapX(hlFrom);
    if (toEnd) hlRightX = x1e;
    else if (hlTo != null && Number.isFinite(hlTo)) hlRightX = mapX(hlTo);
    if (hlLeftX != null && hlRightX != null) {
      const xa = Math.min(hlLeftX, hlRightX), xb = Math.max(hlLeftX, hlRightX);
      innerSvg += `  <line x1="${xa}" y1="${lineY}" x2="${xb}" y2="${lineY}" stroke="#0F766E" stroke-width="5"/>\n`;
    }

    innerSvg += `  <line x1="${x0}" y1="${lineY}" x2="${x1e}" y2="${lineY}" stroke="black" stroke-width="2.5"/>\n`;
    // Arrowheads say "this line carries on"; a bounded scale (a measuring strip, a segment between
    // two known values) shouldn't claim that, so they can be turned off.
    if (showArrowsNl) {
      innerSvg += `  <path d="M ${x0} ${lineY} L ${x0 + 12} ${lineY - 6} L ${x0 + 12} ${lineY + 6} Z" fill="black"/>\n`;
      innerSvg += `  <path d="M ${x1e} ${lineY} L ${x1e - 12} ${lineY - 6} L ${x1e - 12} ${lineY + 6} Z" fill="black"/>\n`;
    }

    // Increment is user-settable; guard against pathologically fine steps on large ranges by
    // auto-coarsening the effective step rather than silently truncating ticks partway through the line.
    const EPS = 1e-9;
    const maxTicks = 400;
    const rawTickCount = Math.floor((maxV - minV) / step + EPS) + 1;
    if (rawTickCount > maxTicks) step = (maxV - minV) / (maxTicks - 1);
    const tickCount = Math.floor((maxV - minV) / step + EPS) + 1;

    // A wide range at interval 1 (e.g. -9 to 9) packs many tick labels into the fixed-width line —
    // at the user's chosen font size they'd overlap into an unreadable smear. First shrink the tick
    // label font to fit the space available between ticks; if even a small floor size still can't
    // fit, thin out which ticks get a text label (every tick mark still gets drawn) the way a ruler
    // labels every 5th/10th mark instead of every one.
    const pxPerTick = tickCount > 1 ? usableW / (tickCount - 1) : usableW;
    let maxLabelChars = 1;
    for (let i = 0; i < tickCount; i++) {
      maxLabelChars = Math.max(maxLabelChars, (Math.round((minV + i * step) * 1e6) / 1e6).toString().length);
    }
    const CHAR_W = 0.58; // approx glyph width as a fraction of font size, for bold digit-heavy labels
    const neededWidth = maxLabelChars * fontSize * CHAR_W + 10; // + a visual breathing-room gap
    let tickFontSize = fontSize, labelStep = 1;
    if (neededWidth > pxPerTick) {
      const MIN_FONT = 11;
      tickFontSize = Math.max(MIN_FONT, Math.floor(fontSize * pxPerTick / neededWidth));
      const neededAtFloor = maxLabelChars * tickFontSize * CHAR_W + 10;
      if (neededAtFloor > pxPerTick) labelStep = Math.max(1, Math.ceil(neededAtFloor / pxPerTick));
    }

    for (let i = 0; i < tickCount; i++) {
      const v = minV + i * step;
      const x = mapX(v);
      innerSvg += `  <line x1="${x}" y1="${lineY - 8}" x2="${x}" y2="${lineY + 8}" stroke="black" stroke-width="2"/>\n`;
      if (showLabelsNl && (i % labelStep === 0 || i === tickCount - 1)) {
        const label = (Math.round(v * 1e6) / 1e6).toString();
        labelSpecs.push({ x, y: lineY + 28, text: label, fontSize: tickFontSize });
      }
    }

    if (!fromEnd && hlFrom != null && Number.isFinite(hlFrom)) {
      const x = mapX(hlFrom);
      innerSvg += `  <circle cx="${x}" cy="${lineY}" r="7" fill="${fromOpen ? "white" : "black"}" stroke="black" stroke-width="2"/>\n`;
    }
    if (!toEnd && hlTo != null && Number.isFinite(hlTo)) {
      const x = mapX(hlTo);
      innerSvg += `  <circle cx="${x}" cy="${lineY}" r="7" fill="${toOpen ? "white" : "black"}" stroke="black" stroke-width="2"/>\n`;
    }

    const boxX = 0, boxY = lineY - 55, boxW = 500, boxH = 110;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "fraction") {
    const style = $("fracStyle").value;
    const num = Math.max(0, parseInt($("fracNumerator").value) || 0);
    const den = Math.max(1, parseInt($("fracDenominator").value) || 1);
    const showLabel = $("fracShowLabel").checked;
    const fontSize = parseInt($("fracFontSize").value) || 24;
    const shadeColor = "rgba(15,118,110,0.35)";

    let innerSvg = "";
    let boxX, boxY, boxW, boxH;

    if (style === "circle") {
      const center = { x: 250, y: 250 }, R = 150;
      for (let i = 0; i < den; i++) {
        const a0 = -Math.PI / 2 + i * (2 * Math.PI / den);
        const a1 = -Math.PI / 2 + (i + 1) * (2 * Math.PI / den);
        const p0 = { x: center.x + R * Math.cos(a0), y: center.y + R * Math.sin(a0) };
        const p1 = { x: center.x + R * Math.cos(a1), y: center.y + R * Math.sin(a1) };
        const largeArc = (a1 - a0) > Math.PI ? 1 : 0;
        const fill = i < num ? shadeColor : "none";
        innerSvg += `  <path d="M ${center.x} ${center.y} L ${p0.x} ${p0.y} A ${R} ${R} 0 ${largeArc} 1 ${p1.x} ${p1.y} Z" fill="${fill}" stroke="black" stroke-width="2"/>\n`;
      }
      boxX = center.x - R - 16; boxY = center.y - R - 16; boxW = (R + 16) * 2; boxH = (R + 16) * 2;
    } else {
      const w = 360, h = 110, x0 = 70, y0 = 195;
      const segW = w / den;
      for (let i = 0; i < den; i++) {
        const fill = i < num ? shadeColor : "none";
        innerSvg += `  <rect x="${x0 + i * segW}" y="${y0}" width="${segW}" height="${h}" fill="${fill}" stroke="black" stroke-width="2"/>\n`;
      }
      boxX = x0 - 16; boxY = y0 - 16; boxW = w + 32; boxH = h + 32;
    }

    if (showLabel) {
      labelSpecs.push({ x: boxX + boxW / 2, y: boxY + boxH + 34, text: `${num}/${den}`, fontSize });
    }

    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;
  }

  // Probability and data diagrams (js/shape-prob.js). srcBox stays null on purpose — that's what
  // makes them re-editable, so reopening one can change five spinner sections to six.
  else if (PROB_SHAPE_BUILDERS[type]) {
    svgString = PROB_SHAPE_BUILDERS[type]();
  }

  // Returned unmarked — only the placement path stamps it (see stampShapeMathFaces).
  return { svgString, labelSpecs, srcBox, fnErrors, hotspots, handles };
}

function generateAndInsertMathShape() {
  const built = buildMathShapeSVG();
  const { labelSpecs, srcBox } = built;
  const type = $("shapeTypeSelect").value; // decides which placed-size default applies
  // Leaving the dialog, so record which faces its maths needs — the fonts themselves are spliced
  // in on the way to an <img> or a file, not stored (see stampShapeMathFaces).
  const svgString = stampShapeMathFaces(built.svgString);
  const target = editingShapeTarget; // capture before .close() clears it (see shape-tools.js)
  const genParams = captureShapeGenParams(); // null for non-graph shapes — not re-editable
  $("shapeImporterDlg").close();
  if (target) {
    replaceGeneratedShape(target, svgString, genParams);
  } else {
    beginShapePlacement(svgString, labelSpecs, srcBox, genParams, type);
  }
}

function togglePlaneFnHelp(id = "planeFnHelp") {
  const help = $(id);
  help.style.display = help.style.display === "none" ? "block" : "none";
}

function toggleAxisLabelInputs(checkboxId, xLabelId, yLabelId) {
  const on = $(checkboxId).checked;
  $(xLabelId).disabled = !on;
  $(yLabelId).disabled = !on;
}
function eqRowHTML(expr, label, enabled) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div class="eq-row" style="display:flex; align-items:center; gap:6px; margin-top:6px;">
          <input type="checkbox" class="eq-enabled" ${enabled ? "checked" : ""} title="Show/hide this equation">
          <input type="text" class="eq-label" value="${esc(label)}" placeholder="label" style="width:64px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; font-size:11.5px; box-sizing:border-box;">
          <input type="text" class="eq-expr" value="${esc(expr)}" placeholder="e.g. sin(x)" style="flex:1; padding:4px 6px; border:1px solid var(--line); border-radius:6px; font-family: ui-monospace, monospace; font-size:12px; box-sizing:border-box;">
          <button type="button" class="side-btn" style="width:auto; margin-top:0; padding:2px 8px;" onclick="removeEqRow(this)">✕</button>
        </div>`;
}
function addEqRow(listId, expr = "", label = "", enabled = true) {
  $(listId).insertAdjacentHTML("beforeend", eqRowHTML(expr, label, enabled));
  renderShapePreview();
}
function removeEqRow(btn) {
  btn.closest(".eq-row").remove();
  renderShapePreview();
}

// The real insertion places labels as independent canvas objects (never clipped by the shape
// image's own crop box), but the dialog preview overlays them INSIDE one combined SVG — so that
// SVG's viewBox has to be widened to actually contain them, or they render outside it and vanish.
// `extras` are grips and hotspots: they live outside srcBox on purpose (a rotate grip orbits the
// shape, and its degrees readout sits further out still) and must be inside the PREVIEW's viewBox
// or they'd be silently clipped. srcBox itself is untouched, so the shape that actually gets
// placed is unaffected by where any of them sit.
function previewViewBoxFor(srcBox, labelSpecs, extras = []) {
  let minX = srcBox.x, minY = srcBox.y, maxX = srcBox.x + srcBox.w, maxY = srcBox.y + srcBox.h;
  for (const s of labelSpecs) {
    const m = shapeLabelMetrics(s.text, s.fontSize, SHAPE_LABEL_CSS);
    const halfW = Math.max(20, m.w / 2), halfH = Math.max(s.fontSize * 0.9, m.h * 0.7);
    minX = Math.min(minX, s.x - halfW); maxX = Math.max(maxX, s.x + halfW);
    minY = Math.min(minY, s.y - halfH); maxY = Math.max(maxY, s.y + halfH);
  }
  for (const e of extras) {
    if (e.stable) { // a square that every angle of this shape fits inside — see the note at its source
      minX = Math.min(minX, e.stable.cx - e.stable.r); maxX = Math.max(maxX, e.stable.cx + e.stable.r);
      minY = Math.min(minY, e.stable.cy - e.stable.r); maxY = Math.max(maxY, e.stable.cy + e.stable.r);
      continue;
    }
    const halfW = (e.w || 0) / 2 + 16, halfH = (e.h || 0) / 2 + 16;
    minX = Math.min(minX, e.cx - halfW); maxX = Math.max(maxX, e.cx + halfW);
    minY = Math.min(minY, e.cy - halfH); maxY = Math.max(maxY, e.cy + halfH);
  }
  return { x: Math.floor(minX), y: Math.floor(minY), w: Math.ceil(maxX - minX), h: Math.ceil(maxY - minY) };
}

// The interaction layer, drawn only into the preview. Hotspots are invisible until hovered so the
// preview still reads as the shape you're about to insert, not as a diagram of its own controls.
function shapeHotspotMarkup(labelSpecs, hotspots, scale) {
  const s = n => n / scale; // keep corner radii a constant on-screen size whatever the zoom is
  let out = `<g class="shape-overlay-hots">\n`;
  for (const h of hotspots) {
    if (h.field === shapeEditingField) continue; // see note on shapeEditingField
    out += `  <rect class="shape-hot${h.placeholder ? " placeholder" : ""}" data-field="${h.field}" x="${h.cx - h.w / 2}" y="${h.cy - h.h / 2}" width="${h.w}" height="${h.h}" rx="${s(4)}" stroke-width="${s(1)}"><title>Click to edit ${escapeXml(h.title || "")}</title></rect>\n`;
    // A readout is a value the shape has but doesn't otherwise draw (rotation). It replaces a form
    // control outright, so unlike a hotspot over an existing label it has to render its own text.
    if (h.text) {
      out += `  <text class="shape-readout" x="${h.cx}" y="${h.cy + (h.fontSize || 13) * 0.36}" font-size="${h.fontSize || 13}" text-anchor="middle">${escapeXml(h.text)}</text>\n`;
    }
  }
  labelSpecs.forEach((l, i) => {
    if (!l.field || l.field === shapeEditingField) return;
    const m = shapeLabelMetrics(l.text, l.fontSize, SHAPE_LABEL_CSS);
    const w = Math.max(28, m.w + 8), hh = Math.max(l.fontSize * 1.5, m.h + 6);
    out += `  <rect class="shape-hot" data-field="${l.field}" data-label="${i}" x="${l.x - w / 2}" y="${l.y - hh * 0.72}" width="${w}" height="${hh}" rx="${s(4)}"><title>Click to edit this label</title></rect>\n`;
  });
  return out + `</g>\n`;
}
function shapeGripMarkup(handles, scale) {
  const s = n => n / scale; // grips stay a constant on-screen size across a 500-unit graph and a 200-unit triangle
  return `<g class="shape-overlay-grips">\n` + handles.map((h, i) =>
    `  <circle class="shape-grip shape-grip-${h.kind}" data-handle="${i}" cx="${h.cx}" cy="${h.cy}" r="${s(9)}" stroke-width="${s(2)}"><title>${escapeXml(h.title || "")}</title></circle>\n`
  ).join("") + `</g>\n`;
}

let shapePreviewHandles = []; // the live handles for whatever is currently drawn, by index
let shapeDragging = null;     // {apply} captured at pointerdown — see onShapeStagePointerDown
/* The field an inline editor is currently open on, if any. Its own box is left undrawn while that
   editor is up, because the box's position is a function of the value being typed: the rotation
   readout orbits the shape, so typing "90" swung it away from the editor sitting still on top of
   it, and a tick box that slid out from under the caret read as a bug. The editor stands in for it
   until it's dismissed.

   Note the hotspot is only skipped when DRAWING — it's still passed to previewViewBoxFor, so the
   space it occupies stays reserved and the whole preview doesn't rescale mid-keystroke. */
let shapeEditingField = null;

function renderShapePreview() {
  updateGraphFitHint(); // before the build, so a momentarily-unbuildable graph still gets its hint
  let svgString, labelSpecs, srcBox, fnErrors, hotspots, handles;
  try {
    ({ svgString, labelSpecs, srcBox, fnErrors, hotspots, handles } = buildMathShapeSVG());
  } catch (err) {
    return; // fields mid-edit / momentarily invalid — keep showing the last good preview
  }
  shapePreviewHandles = handles;
  let preview = svgString;
  // pointer-events="none" so a click on a label falls through to the hotspot rect beneath it —
  // these preview labels sit ON TOP of their own click targets so a hover tint reads as a
  // highlight behind the text rather than painting over it.
  // Routed through the same helper the shape's own labels use, so a "$...$" side length previews as
  // the maths it will become. It really does become that: placement turns each of these into a
  // normal text object (finalizePendingPlacement), and those have supported inline maths all along
  // — so before this the preview was the only place showing raw LaTeX.
  const labelsMarkup = labelSpecs.map(s => shapeLabelSvg(s.text, {
    x: s.x, y: s.y, fontSize: s.fontSize, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS,
  })).join("");
  let box = srcBox;
  if (srcBox && (labelSpecs.length || handles.length || hotspots.length)) {
    box = previewViewBoxFor(srcBox, labelSpecs, handles.concat(hotspots));
    preview = preview.replace(
      /viewBox="[^"]*" width="[^"]*" height="[^"]*"/,
      `viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${box.w}" height="${box.h}"`
    );
  }
  // Grips are sized in viewBox units, so they need the box-to-pixels ratio to come out a constant
  // size on screen — a 500-unit-wide graph and a 200-unit-wide triangle otherwise get grips that
  // differ by more than 2x.
  const stageW = $("shapePreview").clientWidth || 420;
  const scale = box ? Math.max(0.05, stageW / box.w) : 1;
  // Paint order matters: hotspots underneath, then the labels they belong to, then grips on top so
  // a grip overlapping a label is still the thing you grab.
  preview = preview.replace("</svg>",
    shapeHotspotMarkup(labelSpecs, hotspots, scale) + labelsMarkup + shapeGripMarkup(handles, scale) + "</svg>");
  // No font payload here: this SVG is inline in the page, so the page's own stylesheet reaches
  // into its foreignObjects.
  $("shapePreview").innerHTML = preview;
  const hint = $("shapeStageHint");
  if (hint) {
    const bits = [];
    if (handles.some(h => h.kind === "vertex")) bits.push("drag a corner");
    if (handles.some(h => h.kind === "rotate")) bits.push("drag the outer grip to rotate");
    if (hotspots.length || labelSpecs.some(l => l.field)) bits.push("click a value on the shape to edit it");
    hint.textContent = bits.join(" · ");
  }

  const type = $("shapeTypeSelect").value;
  const FN_STATUS_IDS = { plane: "planeFnStatus", planeMath: "pmFnStatus", planeQ1: "q1FnStatus" };
  const statusId = FN_STATUS_IDS[type];
  Object.values(FN_STATUS_IDS).forEach(id => { if (id !== statusId) $(id).style.display = "none"; });
  const status = statusId ? $(statusId) : null;
  if (status && fnErrors && fnErrors.length) {
    status.textContent = fnErrors.join(" · ");
    status.style.display = "block";
  } else if (status) {
    status.style.display = "none";
  }
}
/* ---------------- direct manipulation on the preview ---------------- */

// Screen pixels -> the SVG's own coordinate space, which is what handles' apply() expects. Uses the
// live CTM rather than any assumption about the viewBox, so it stays correct as the preview
// rescales (and it re-crops on every render, so it does).
function shapeSvgPoint(svg, ev) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(ctm.inverse());
}

// Writes straight into the form field the grip is bound to, then fires `input` so everything
// already listening (the preview, the graph fit hint, prefs) updates exactly as if it had been
// typed. The form stays the single source of truth — dragging is another way to write to it, not a
// parallel state to keep in sync.
function shapeSetField(id, value) {
  const el = $(id);
  if (!el || String(el.value) === String(value)) return;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/* Pointer capture is taken on #shapePreview, NOT on the grip: every move rewrites the stage's
   innerHTML to redraw the shape, so the grip element under the pointer is destroyed and rebuilt
   many times per drag. Capturing on the container — which survives — is what keeps the drag alive.

   The handle's apply() is captured once at pointerdown and reused for the whole drag. It closes
   over the geometry of the build that produced it, but that costs nothing: the transform is exact
   and affine, so applying a stale one to the pointer's current absolute position lands the vertex
   under the pointer either way. Re-reading it each move would mean tracking indices across
   rebuilds for no gain. */
function onShapeStagePointerDown(e) {
  const stage = $("shapePreview");
  const grip = e.target.closest(".shape-grip");
  if (grip) {
    const h = shapePreviewHandles[+grip.dataset.handle];
    if (!h || !h.apply) return;
    e.preventDefault();
    closeShapeInlineEditor();
    shapeDragging = { apply: h.apply, kind: h.kind };
    stage.classList.add("dragging");
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  const hot = e.target.closest(".shape-hot");
  if (hot) { e.preventDefault(); openShapeInlineEditor(hot.dataset.field, hot); }
}
function onShapeStagePointerMove(e) {
  if (!shapeDragging) return;
  e.preventDefault();
  const svg = $("shapePreview").querySelector("svg");
  const pt = svg && shapeSvgPoint(svg, e);
  if (!pt) return;
  const next = shapeDragging.apply({ x: pt.x, y: pt.y });
  for (const [id, v] of Object.entries(next)) shapeSetField(id, v);
}
function onShapeStagePointerUp(e) {
  if (!shapeDragging) return;
  shapeDragging = null;
  $("shapePreview").classList.remove("dragging");
  try { $("shapePreview").releasePointerCapture(e.pointerId); } catch (_) {}
  renderShapePreview(); // drop back to the tight crop now the sweep no longer needs reserving
}

// A one-field editor floating over the spot you clicked. Deliberately not a re-implementation of
// the input: it reads and writes the real form field, so validation, defaults and the preview all
// behave identically whether you type here or in the column.
function openShapeInlineEditor(fieldId, anchorEl) {
  const src = $(fieldId);
  if (!src) return;
  closeShapeInlineEditor();
  const box = anchorEl.getBoundingClientRect();
  const stage = $("shapePreview").getBoundingClientRect();
  const ed = document.createElement("input");
  ed.type = src.type === "number" ? "number" : "text";
  if (src.step) ed.step = src.step;
  ed.value = src.value;
  ed.className = "shape-inline-edit";
  ed.style.left = Math.round(Math.max(2, Math.min(box.left - stage.left + box.width / 2 - 42, stage.width - 88))) + "px";
  ed.style.top = Math.round(Math.max(2, Math.min(box.top - stage.top + box.height / 2 - 13, stage.height - 30))) + "px";
  // stopPropagation so the dialog-level listener doesn't render a second time for the same keystroke
  // — shapeSetField's own dispatch on the real field already triggers exactly one.
  ed.oninput = ev => { ev.stopPropagation(); shapeSetField(fieldId, ed.value); };
  ed.onkeydown = ev => {
    if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeShapeInlineEditor(); }
    else ev.stopPropagation(); // don't let the dialog's own shortcuts eat what's being typed
  };
  ed.onblur = () => closeShapeInlineEditor();
  $("shapePreview").parentElement.appendChild(ed);
  // Set before the redraw so the box this editor covers is already gone by the time it appears,
  // rather than flashing away on the first keystroke.
  shapeEditingField = fieldId;
  renderShapePreview();
  ed.focus();
  ed.select();
}
function closeShapeInlineEditor() {
  const old = document.querySelector(".shape-inline-edit");
  if (old) { old.onblur = null; old.remove(); }
  if (shapeEditingField) { shapeEditingField = null; renderShapePreview(); } // bring its box back
}

$("shapePreview").addEventListener("pointerdown", onShapeStagePointerDown);
$("shapePreview").addEventListener("pointermove", onShapeStagePointerMove);
$("shapePreview").addEventListener("pointerup", onShapeStagePointerUp);
$("shapePreview").addEventListener("pointercancel", onShapeStagePointerUp);

/* A slider physically cannot leave its range; a typed number can, and these fields drive real
   geometry — a font size of 500 renders a label bigger than the page it's on. So the bounds the
   sliders used to enforce are enforced here instead.
   Only the upper bound is applied while typing: clamping up as well would rewrite "1" to the
   minimum the instant it was typed, making "16" impossible to enter. The lower bound waits for
   change (blur or Enter), by which point the number is finished. */
function clampShapeNumberField(el, both) {
  if (!el || el.type !== "number" || el.value === "") return;
  const v = parseFloat(el.value);
  if (!Number.isFinite(v)) return;
  const min = el.min === "" ? -Infinity : parseFloat(el.min);
  const max = el.max === "" ? Infinity : parseFloat(el.max);
  const next = Math.min(max, both ? Math.max(min, v) : v);
  if (next !== v) el.value = next;
}
// A formula's first render is async (KaTeX and its fonts come off a CDN), so the label falls back
// to raw source for that one frame and this redraws it once the real thing is available.
shapeMathOnReady = () => { if ($("shapeImporterDlg").open) renderShapePreview(); };

$("shapeImporterDlg").addEventListener("input", e => {
  clampShapeNumberField(e.target, false);
  renderShapePreview();
});
$("shapeImporterDlg").addEventListener("change", e => {
  clampShapeNumberField(e.target, true);
  renderShapePreview();
});
// Only checkbox commits are notebook-level prefs worth persisting — other fields
// (dimensions, labels, ...) are per-insert, not saved anywhere.
$("shapeImporterDlg").addEventListener("change", e => { if (e.target.matches('input[type="checkbox"]')) captureShapePrefsFromDialog(); });

/* ============================================================================
   Shared dialogs: confirm, and a page picker
   ========================================================================== */
