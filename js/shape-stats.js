"use strict";
/* ============================================================================
   Statistical displays — stem-and-leaf, frequency histogram, box plot.

   Same contract as the probability diagrams in shape-prob.js: each returns one complete <svg>
   string, none of them return a srcBox, and their labels stay inside the SVG — which is what
   registers them as re-editable, so a mistyped data value can be corrected by reopening the
   dialog rather than deleting the picture and starting again.
   ========================================================================== */

// Numbers out of a free-typed list. Commas OR whitespace OR semicolons, because data gets pasted
// from wherever it came from and insisting on one separator is a good way to make a tool annoying.
function probData(raw) {
  return String(raw == null ? "" : raw).split(/[\s,;]+/)
    .map(s => parseFloat(s)).filter(Number.isFinite);
}
// The five-number summary as taught in school: the median splits the data, and each quartile is
// the median of its own half with the middle value EXCLUDED when the count is odd. Other
// conventions exist (and spreadsheets use one of them), but this is the one being marked.
function fiveNumberSummary(values) {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const med = arr => {
    const m = arr.length;
    if (!m) return null;
    return m % 2 ? arr[(m - 1) / 2] : (arr[m / 2 - 1] + arr[m / 2]) / 2;
  };
  const half = Math.floor(n / 2);
  const q1 = med(s.slice(0, half)), q3 = med(s.slice(n % 2 ? half + 1 : half));
  return { min: s[0], q1: q1 == null ? s[0] : q1, med: med(s), q3: q3 == null ? s[n - 1] : q3, max: s[n - 1] };
}
// A round number to step an axis by: 1, 2, 2.5, 5, 10, 20 ... whichever gives roughly `target`
// intervals. Hand-drawn axes never step by 3.7.
function niceStep(range, target) {
  const raw = (range || 1) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (mag * m >= raw) return mag * m;
  return mag * 10;
}
// Trailing ".0" is noise on an axis that steps in whole numbers.
const axisNum = v => String(Math.round(v * 1000) / 1000);
// The label styles these share: headings bold, data values plain.
const STAT_PLAIN_ATTRS = SHAPE_LABEL_ATTRS.replace('font-weight="bold"', 'font-weight="normal"');
const STAT_PLAIN_CSS = SHAPE_LABEL_CSS.replace("font-weight:bold;", "");

function statPlaceholder(msg, w) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 80" width="${w}" height="80">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n` +
    shapeLabelSvg(msg, { x: w / 2, y: 48, fontSize: 19, fill: "#98A2B3",
      attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS }) + `</svg>`;
}

/* ---------------- stem-and-leaf ----------------
   One tool for both shapes: fill in the second data set and it becomes back-to-back. Stems run
   over the whole range INCLUDING empty ones — a stem with no leaves is a real gap in the
   distribution, and skipping the row is the classic way to make the plot lie about its shape. */
function buildStemLeafSvg() {
  const unit = Math.max(1, probNum($("slUnit").value, 10)); // what one step of the stem is worth
  const left = probData($("slDataB").value);
  const right = probData($("slData").value);
  const backToBack = left.length > 0;
  const fontSize = Math.max(8, probNum($("slFontSize").value, 22));
  const titleR = $("slTitle").value.trim();
  const titleL = $("slTitleB").value.trim();

  const stemOf = v => Math.floor(v / unit);
  const leafOf = v => Math.abs(Math.round(v - stemOf(v) * unit));
  const all = right.concat(left);
  if (!all.length) return statPlaceholder("(type some data values)", 340);

  const lo = stemOf(Math.min(...all)), hi = stemOf(Math.max(...all));
  const stems = [];
  for (let s = lo; s <= hi && stems.length < 60; s++) stems.push(s);
  const leavesOn = (arr, s) => arr.filter(v => stemOf(v) === s).map(leafOf).sort((a, b) => a - b);

  const ch = shapeLabelMetrics("8", fontSize, STAT_PLAIN_CSS).w * 1.3; // one leaf column
  const rowH = Math.round(fontSize * 1.5);
  const stemW = Math.max(ch * 2, ...stems.map(s => shapeLabelMetrics(String(s), fontSize, SHAPE_LABEL_CSS).w)) + ch;
  const widest = arr => Math.max(0, ...stems.map(s => leavesOn(arr, s).length));
  const rightW = Math.max(ch * 3, widest(right) * ch + ch);
  const leftW = backToBack ? Math.max(ch * 3, widest(left) * ch + ch) : 0;

  const titleH = (titleR || titleL) ? rowH * 1.2 : 0;
  const W = Math.round(leftW + stemW + rightW) + 24;
  const H = Math.round(titleH + stems.length * rowH + rowH * 1.7) + 20;
  const x0 = 12, stemL = x0 + leftW, stemR = stemL + stemW, y0 = 10 + titleH;

  let inner = "";
  if (titleL) inner += shapeLabelSvg(titleL, { x: stemL - 8, y: y0 - rowH * 0.4, fontSize,
    anchor: "end", fill: "#1B4F91", attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  if (titleR) inner += shapeLabelSvg(titleR, { x: stemR + 8, y: y0 - rowH * 0.4, fontSize,
    anchor: "start", fill: "#1B4F91", attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });

  const bottom = y0 + stems.length * rowH;
  inner += `  <line x1="${pn(stemL)}" y1="${pn(y0)}" x2="${pn(stemL)}" y2="${pn(bottom)}" stroke="${PROB_INK}" stroke-width="2"/>\n`;
  if (backToBack) {
    inner += `  <line x1="${pn(stemR)}" y1="${pn(y0)}" x2="${pn(stemR)}" y2="${pn(bottom)}" stroke="${PROB_INK}" stroke-width="2"/>\n`;
  }
  stems.forEach((s, i) => {
    const cy = y0 + i * rowH + rowH * 0.72;
    inner += shapeLabelSvg(String(s), { x: (stemL + stemR) / 2, y: cy, fontSize, fill: PROB_INK,
      attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
    leavesOn(right, s).forEach((d, k) => {
      inner += shapeLabelSvg(String(d), { x: stemR + ch * 0.8 + k * ch, y: cy, fontSize,
        fill: PROB_INK, attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS });
    });
    // The left side mirrors it — smallest leaf nearest the stem — so both halves read outward.
    leavesOn(left, s).forEach((d, k) => {
      inner += shapeLabelSvg(String(d), { x: stemL - ch * 0.8 - k * ch, y: cy, fontSize,
        fill: PROB_INK, attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS });
    });
  });
  // Without a key a stem-and-leaf is ambiguous about its own scale, so it is not optional.
  inner += shapeLabelSvg(`Key: ${stems[0]} | 2 means ${stems[0] * unit + 2}`, {
    x: stemL, y: bottom + rowH * 1.15, fontSize: fontSize * 0.8, anchor: "start", fill: "#4A5568",
    attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}

/* ---------------- frequency histogram ----------------
   Bars touching is a histogram (continuous classes); bars separated is a bar chart. Identical
   drawing otherwise, so it is a checkbox rather than a second tool. */
function buildHistogramSvg() {
  const freqs = probData($("hgFreqs").value);
  const start = probNum($("hgStart").value, 0);
  const width = Math.max(0.0001, probNum($("hgWidth").value, 1));
  const cats = probList($("hgLabels").value, []);
  const gapped = $("hgGap").checked;
  const fontSize = Math.max(8, probNum($("hgFontSize").value, 20));
  const xTitle = $("hgXLabel").value.trim();
  const yTitle = $("hgYLabel").value.trim();
  const fill = $("hgFill").value || "#8286BC";
  // Per-bar colours, so one class can be picked out ("which interval holds the median?") without
  // recolouring the rest. Blank entries keep the shared colour.
  const barFills = probColours($("hgBarColours").value, Math.max(1, freqs.length), () => fill);
  // The textbook style runs the axis from 0 even when the first class starts at 100, leaving a
  // visible gap that says "nothing was recorded below here".
  const fromZero = $("hgFromZero").checked && !cats.length && start > 0;
  if (!freqs.length) return statPlaceholder("(type the frequencies)", 340);
  const n = freqs.length;

  const W = 620, H = 470;
  const padL = 90, padR = 50, padB = 96, padT = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const ox = padL, oy = H - padB;

  const maxF = Math.max(1, ...freqs);
  const yStep = niceStep(maxF, 4);
  const yTop = Math.ceil(maxF / yStep) * yStep;
  const yAt = v => oy - (v / yTop) * plotH;
  // Pinned to zero, the classes share the axis with the empty run that comes before them.
  const lead = fromZero ? start / width : 0;
  const barW = plotW / (n + lead);
  const offset = lead * barW;
  const gap = gapped ? barW * 0.2 : 0;

  let inner = "";
  freqs.forEach((f, i) => {
    if (!(f > 0)) return;
    inner += `  <rect x="${pn(ox + offset + i * barW + gap / 2)}" y="${pn(yAt(f))}" ` +
      `width="${pn(barW - gap)}" height="${pn(oy - yAt(f))}" fill="${barFills[i]}" ` +
      `stroke="${PROB_INK}" stroke-width="1.8"/>\n`;
  });
  // Axes over the bars, with the arrowheads the textbook style uses.
  inner += `  <path d="M ${ox} ${oy} L ${pn(ox + plotW + 28)} ${oy}" stroke="${PROB_INK}" stroke-width="2.4"/>\n` +
    `  <path d="M ${pn(ox + plotW + 28)} ${oy} l -14 -6.5 l 0 13 Z" fill="${PROB_INK}"/>\n` +
    `  <path d="M ${ox} ${oy} L ${ox} ${pn(padT - 22)}" stroke="${PROB_INK}" stroke-width="2.4"/>\n` +
    `  <path d="M ${ox} ${pn(padT - 22)} l -6.5 14 l 13 0 Z" fill="${PROB_INK}"/>\n`;
  for (let v = yStep; v <= yTop + 1e-9; v += yStep) {
    inner += `  <line x1="${pn(ox - 7)}" y1="${pn(yAt(v))}" x2="${ox}" y2="${pn(yAt(v))}" stroke="${PROB_INK}" stroke-width="2"/>\n`;
    inner += shapeLabelSvg(axisNum(v), { x: ox - 13, y: yAt(v) + fontSize * 0.35, fontSize,
      anchor: "end", fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  }
  inner += shapeLabelSvg("0", { x: ox - 13, y: oy + fontSize * 0.35, fontSize, anchor: "end",
    fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  // Categories sit under their own bar. Numeric classes label the BOUNDARIES instead, which is
  // what makes "how many between 100 and 200?" answerable straight off the picture.
  if (cats.length) {
    for (let i = 0; i < n; i++) {
      inner += shapeLabelSvg(cats[i] || "", { x: ox + (i + 0.5) * barW, y: oy + fontSize * 1.6,
        fontSize, fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
    }
  } else {
    if (fromZero) inner += shapeLabelSvg("0", { x: ox, y: oy + fontSize * 1.6, fontSize,
      fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
    for (let i = 0; i <= n; i++) {
      const x = ox + offset + i * barW;
      inner += `  <line x1="${pn(x)}" y1="${oy}" x2="${pn(x)}" y2="${pn(oy + 7)}" stroke="${PROB_INK}" stroke-width="2"/>\n`;
      inner += shapeLabelSvg(axisNum(start + i * width), { x, y: oy + fontSize * 1.6, fontSize,
        fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
    }
  }
  if (xTitle) inner += shapeLabelSvg(xTitle, { x: ox + plotW / 2, y: H - 16, fontSize: fontSize * 1.15,
    fill: PROB_INK, attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });
  if (yTitle) inner += shapeLabelSvg(yTitle, { x: 28, y: padT + plotH / 2, fontSize: fontSize * 1.15,
    transform: `rotate(-90 28 ${pn(padT + plotH / 2)})`, fill: PROB_INK,
    attrs: AXIS_LABEL_ATTRS, cssFont: AXIS_LABEL_CSS });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}

/* ---------------- box plot ----------------
   Takes either the five-number summary directly, or raw data it derives one from — the difference
   between drawing an answer and checking one. A second data set stacks a parallel box plot on the
   same scale, since comparing two distributions is most of what these get used for. */
function buildBoxPlotSvg() {
  const raw = $("bxMode").value === "raw";
  const parse = v => {
    const nums = probData(v);
    if (!nums.length) return null;
    if (raw) return fiveNumberSummary(nums);
    if (nums.length < 5) return null;
    // Sorted, so the five can be typed in any order without drawing a box inside out.
    const s = nums.slice(0, 5).sort((a, b) => a - b);
    return { min: s[0], q1: s[1], med: s[2], q3: s[3], max: s[4] };
  };
  const sets = [
    { s: parse($("bxData").value), label: $("bxLabel").value.trim() },
    { s: parse($("bxData2").value), label: $("bxLabel2").value.trim() },
  ].filter(x => x.s);
  const fontSize = Math.max(8, probNum($("bxFontSize").value, 20));
  const showValues = $("bxShowValues").checked;
  const boxFill = $("bxFill").value || "#FFFFFF";
  const boxLine = $("bxColour").value || "#2D4E86";
  if (!sets.length) return statPlaceholder(raw ? "(type the data values)" : "(type five numbers)", 380);

  const dataMin = Math.min(...sets.map(x => x.s.min)), dataMax = Math.max(...sets.map(x => x.s.max));
  const typedStep = probNum($("bxStep").value, 0);
  const step = typedStep > 0 ? typedStep : niceStep(dataMax - dataMin, 6);
  const sMin = Math.floor(dataMin / step) * step;
  const sMax = Math.max(sMin + step, Math.ceil(dataMax / step) * step);

  const anyLabel = sets.some(x => x.label);
  const W = 640, padL = anyLabel ? 122 : 54, padR = 48;
  const boxH = Math.round(fontSize * 2.6), rowGap = Math.round(fontSize * 1.9);
  const topPad = showValues ? Math.round(fontSize * 2.2) + 12 : 26;
  const axisH = Math.round(fontSize * 2.8);
  const H = topPad + sets.length * (boxH + rowGap) + axisH;
  const plotW = W - padL - padR;
  const xAt = v => padL + ((v - sMin) / (sMax - sMin)) * plotW;

  let inner = "";
  sets.forEach((set, i) => {
    const { min, q1, med, q3, max } = set.s;
    const cy = topPad + i * (boxH + rowGap) + boxH / 2;
    const t = cy - boxH / 2, bm = cy + boxH / 2;
    // Whiskers first, so the box paints over their inner ends rather than showing a line through.
    inner += `  <line x1="${pn(xAt(min))}" y1="${pn(cy)}" x2="${pn(xAt(q1))}" y2="${pn(cy)}" stroke="${boxLine}" stroke-width="2.4"/>\n` +
      `  <line x1="${pn(xAt(q3))}" y1="${pn(cy)}" x2="${pn(xAt(max))}" y2="${pn(cy)}" stroke="${boxLine}" stroke-width="2.4"/>\n` +
      `  <line x1="${pn(xAt(min))}" y1="${pn(t + 4)}" x2="${pn(xAt(min))}" y2="${pn(bm - 4)}" stroke="${boxLine}" stroke-width="2.4"/>\n` +
      `  <line x1="${pn(xAt(max))}" y1="${pn(t + 4)}" x2="${pn(xAt(max))}" y2="${pn(bm - 4)}" stroke="${boxLine}" stroke-width="2.4"/>\n` +
      `  <rect x="${pn(xAt(q1))}" y="${pn(t)}" width="${pn(Math.max(1, xAt(q3) - xAt(q1)))}" height="${boxH}" fill="#FFFFFF" stroke="${boxLine}" stroke-width="2.4"/>\n` +
      `  <line x1="${pn(xAt(med))}" y1="${pn(t)}" x2="${pn(xAt(med))}" y2="${pn(bm)}" stroke="${boxLine}" stroke-width="2.8"/>\n`;
    if (set.label) {
      inner += shapeLabelSvg(set.label, { x: padL - 16, y: cy + fontSize * 0.35, fontSize,
        anchor: "end", fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
    }
    // Only above the top plot: repeated over every row they would land on the box beneath.
    if (showValues && i === 0) {
      [min, q1, med, q3, max].forEach(v => {
        inner += shapeLabelSvg(axisNum(v), { x: xAt(v), y: t - 10, fontSize: fontSize * 0.85,
          fill: "#4A5568", attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS });
      });
    }
  });
  const ay = H - axisH + 6;
  inner += `  <line x1="${pn(padL - 20)}" y1="${pn(ay)}" x2="${pn(padL + plotW + 20)}" y2="${pn(ay)}" stroke="${PROB_INK}" stroke-width="2.2"/>\n`;
  for (let v = sMin, guard = 0; v <= sMax + 1e-9 && guard < 200; v += step, guard++) {
    inner += `  <line x1="${pn(xAt(v))}" y1="${pn(ay)}" x2="${pn(xAt(v))}" y2="${pn(ay + 7)}" stroke="${PROB_INK}" stroke-width="2"/>\n`;
    inner += shapeLabelSvg(axisNum(v), { x: xAt(v), y: ay + fontSize * 1.6, fontSize,
      fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}
