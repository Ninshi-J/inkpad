"use strict";
/* ============================================================================
   Probability & data diagrams — spinner, Venn, table, tree.

   Kept out of shape-svg.js only for size; these are ordinary shape generators and are dispatched
   from buildMathShapeSVG() like every other type. Each returns a complete <svg> string.

   All four differ from a triangle in one way that matters: they return NO srcBox, which is what
   marks a shape as re-editable (see the note above editGeneratedShape in shape-tools.js). A
   spinner's numbers or a tree's branch labels are positioned by the generator, so if they were
   spun out into free-floating text objects at placement they'd stay put when you reopened the
   dialog and changed five sections to six. Keeping them inside the SVG means "✎ Edit" can just
   regenerate the whole picture. Labels still go through shapeLabelSvg(), so "$...$" works in any
   of them.

   Everything is laid out in a 0..W by 0..H user-space box; the placed size is decided later from
   the shape defaults, so these only have to get proportions right. */

// Section fills, in the order a spinner or Venn uses them. Chosen to stay distinguishable in
// greyscale print as well as on screen, since these get photocopied.
const PROB_FILLS = ["#E2483F", "#F2C438", "#3B93D6", "#5FA860", "#E88C28", "#8E6BBF", "#DE7CA8", "#7FBEC4"];
const PROB_INK = "#1F2933";
const PROB_HEADER_FILL = "#DCE9F5";

// "a, b , c" -> ["a","b","c"], dropping blanks. Commas because that's what someone types.
function probList(raw, fallback) {
  const out = String(raw == null ? "" : raw).split(",").map(s => s.trim()).filter(s => s !== "");
  return out.length ? out : (fallback || []);
}
const probNum = (raw, dflt) => { const v = parseFloat(raw); return Number.isFinite(v) ? v : dflt; };
/* A per-item colour list, falling back to the shared palette. Accepts anything CSS does — "red",
   "#e2483f", "rgb(...)" — because typing a word is faster than opening a picker, and blanks fall
   through to the default so "keep the first two, recolour the third" is ",,green". */
function probColours(raw, count, fallback) {
  const typed = String(raw == null ? "" : raw).split(",").map(s => s.trim());
  return Array.from({ length: count }, (_, i) =>
    typed[i] || (fallback ? fallback(i) : PROB_FILLS[i % PROB_FILLS.length]));
}
// A rounded value that still reads as an integer when it is one — SVG coordinates with long
// decimal tails bloat the string for no visual gain.
const pn = v => Math.round(v * 100) / 100;

/* ---------------- spinner ----------------
   Sections are equal unless weights are given, which is the whole point of the "is this spinner
   fair?" question — an unequal spinner has to be drawable. */
function buildSpinnerSvg() {
  const labels = probList($("spLabels").value, ["1", "2", "3", "4"]).slice(0, 16);
  const n = labels.length;
  const weightsIn = probList($("spWeights").value, []).map(s => Math.max(0.01, probNum(s, 1)));
  const weights = Array.from({ length: n }, (_, i) => weightsIn.length ? (weightsIn[i % weightsIn.length]) : 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const fontSize = Math.max(8, probNum($("spFontSize").value, 26));
  const coloured = $("spColour").checked;
  const pointer = $("spPointer").checked;
  /* Per-section colours, so "shade the sections showing a 3" is one field rather than a limitation.
     The default gives sections SHARING A LABEL the same colour, because on a "1, 2, 3, 3" spinner
     the two 3s are one outcome — colouring them differently is the picture arguing against the
     question being asked about it. Distinct labels still cycle the palette as before, and the
     colour list overrides any of it. */
  const swatch = new Map();
  labels.forEach(t => { if (!swatch.has(t)) swatch.set(t, PROB_FILLS[swatch.size % PROB_FILLS.length]); });
  const fills = probColours($("spColourList").value, n,
    i => (coloured ? swatch.get(labels[i]) : "#FFFFFF"));

  const S = 500, cx = S / 2, cy = S / 2, r = 195;
  const pt = a => `${pn(cx + r * Math.cos(a))} ${pn(cy + r * Math.sin(a))}`;
  let inner = "";
  let a0 = -Math.PI / 2; // first boundary at 12 o'clock, like a drawn-by-hand spinner
  const mids = [];
  for (let i = 0; i < n; i++) {
    const sweep = (weights[i] / total) * Math.PI * 2;
    const a1 = a0 + sweep;
    const fill = fills[i];
    if (n === 1) {
      inner += `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${PROB_INK}" stroke-width="3"/>\n`;
    } else {
      const large = sweep > Math.PI ? 1 : 0;
      inner += `  <path d="M ${cx} ${cy} L ${pt(a0)} A ${r} ${r} 0 ${large} 1 ${pt(a1)} Z" ` +
        `fill="${fill}" stroke="${PROB_INK}" stroke-width="3" stroke-linejoin="round"/>\n`;
    }
    mids.push((a0 + a1) / 2);
    a0 = a1;
  }
  // Outline last so the sector strokes can't sit on top of it and thin it unevenly.
  inner += `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${PROB_INK}" stroke-width="3.5"/>\n`;
  labels.forEach((text, i) => {
    const lr = r * 0.66;
    inner += shapeLabelSvg(text, {
      x: cx + lr * Math.cos(mids[i]), y: cy + lr * Math.sin(mids[i]) + fontSize * 0.35,
      fontSize, fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS,
    });
  });
  if (pointer) {
    // A stubby arrow rather than a full needle, so it can't be mistaken for a sector boundary.
    inner += `  <path d="M ${cx} ${cy - 8} L ${cx + r * 0.72} ${cy - 3} L ${cx + r * 0.72} ${cy - 13} ` +
      `L ${cx + r * 0.86} ${cy} L ${cx + r * 0.72} ${cy + 13} L ${cx + r * 0.72} ${cy + 3} ` +
      `L ${cx} ${cy + 8} Z" fill="${PROB_INK}"/>\n`;
    inner += `  <circle cx="${cx}" cy="${cy}" r="11" fill="#FFFFFF" stroke="${PROB_INK}" stroke-width="3"/>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}

/* ---------------- Venn ----------------
   The rectangle is the universal set, so the "outside" value has somewhere to live — that region
   is the one students forget, and a Venn drawn as two bare circles gives it nowhere to go. */
function buildVennSvg() {
  const three = $("vnSets").value === "3";
  const fontSize = Math.max(8, probNum($("vnFontSize").value, 24));
  const setFont = fontSize * 1.05;
  const labelA = $("vnLabelA").value.trim() || "A";
  const labelB = $("vnLabelB").value.trim() || "B";
  const labelC = $("vnLabelC").value.trim() || "C";
  const uni = $("vnUniversal").value.trim();
  const tint = $("vnShadeColour").value || "#BBD8EE";

  // Three circles need the extra depth for C's name, which sits below its circle rather than
  // beside it — at 470 it collided with the universal set's own border.
  const W = 520, H = three ? 505 : 380;
  const bx = 20, by = 20, bw = W - 40, bh = H - 40;
  let inner = `  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#FFFFFF" ` +
    `stroke="${PROB_INK}" stroke-width="2.5"/>\n`;

  const cy0 = three ? by + bh * 0.42 : by + bh * 0.52;
  const r = three ? 108 : 118;
  const dx = three ? 62 : 68;
  const circles = three
    ? [{ x: W / 2 - dx, y: cy0, t: labelA }, { x: W / 2 + dx, y: cy0, t: labelB },
       { x: W / 2, y: cy0 + dx * 1.7, t: labelC }]
    : [{ x: W / 2 - dx, y: cy0, t: labelA }, { x: W / 2 + dx, y: cy0, t: labelB }];

  /* Shading, one checkbox per region, so any combination is reachable — "A only", "everything
     except B", "just the middle" are all the same mechanism rather than five hard-coded presets.

     Every region is "the circles it's inside, minus the circles it's outside". Intersection comes
     from NESTED clip paths (each one narrows what's left), subtraction from a mask that paints the
     excluded circles black. The outside region is the degenerate case with nothing to intersect,
     which is why it falls out of the same code instead of needing its own. Drawn before the
     outlines so a shaded region reads as one solid area, not two overlapping translucent discs. */
  const REGIONS = three
    ? [["a", [0], [1, 2]], ["b", [1], [0, 2]], ["c", [2], [0, 1]],
       ["ab", [0, 1], [2]], ["ac", [0, 2], [1]], ["bc", [1, 2], [0]],
       ["abc", [0, 1, 2], []], ["out", [], [0, 1, 2]]]
    : [["a", [0], [1]], ["b", [1], [0]], ["ab", [0, 1], []], ["out", [], [0, 1]]];
  const on = REGIONS.filter(([key]) => { const el = $("vnShade_" + key); return el && el.checked; });
  if (on.length) {
    const disc = i => `<circle cx="${circles[i].x}" cy="${circles[i].y}" r="${r}"`;
    let defs = "", body = "";
    circles.forEach((_, i) => { defs += `    <clipPath id="vnc${i}">${disc(i)}/></clipPath>\n`; });
    on.forEach(([key, inc, exc], k) => {
      const maskId = `vnm${k}`;
      if (exc.length) {
        defs += `    <mask id="${maskId}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#fff"/>` +
          exc.map(i => `${disc(i)} fill="#000"/>`).join("") + `</mask>\n`;
      }
      const open = inc.map(i => `<g clip-path="url(#vnc${i})">`).join("");
      body += `  ${open}<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${tint}"` +
        `${exc.length ? ` mask="url(#${maskId})"` : ""}/>${"</g>".repeat(inc.length)}\n`;
    });
    inner += `  <defs>\n${defs}  </defs>\n${body}`;
  }
  for (const c of circles) {
    inner += `  <circle cx="${c.x}" cy="${c.y}" r="${r}" fill="none" stroke="#2D4E86" stroke-width="2.8"/>\n`;
  }
  // Set names outside their circle where there's room, so they never collide with a region value.
  const nameAt = (c, i) => {
    if (three && i === 2) return { x: c.x, y: c.y + r + setFont * 1.1 };
    return { x: c.x + (i === 0 ? -r * 0.72 : r * 0.72), y: c.y - r - setFont * 0.35 };
  };
  circles.forEach((c, i) => {
    const p = nameAt(c, i);
    inner += shapeLabelSvg(c.t, { x: p.x, y: p.y, fontSize: setFont, fill: "#2D4E86",
      attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  });
  if (uni) {
    inner += shapeLabelSvg(uni, { x: bx + 16, y: by + setFont + 4, fontSize: setFont, anchor: "start",
      fill: PROB_INK, attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  }
  // Region values, at the visual centre of each region rather than the centroid of the circles —
  // an intersection's centre is between the two, an "only" region's is pushed away from it.
  const put = (text, x, y) => {
    if (!text) return;
    inner += shapeLabelSvg(text, { x, y: y + fontSize * 0.35, fontSize, fill: PROB_INK,
      attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  };
  const v = id => ($(id) ? $(id).value.trim() : "");
  if (!three) {
    const [A, B] = circles;
    put(v("vnOnlyA"), A.x - r * 0.42, A.y);
    put(v("vnOnlyB"), B.x + r * 0.42, B.y);
    put(v("vnAB"), W / 2, A.y);
  } else {
    const [A, B, C] = circles;
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const centre = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
    put(v("vnOnlyA"), A.x - r * 0.5, A.y - r * 0.22);
    put(v("vnOnlyB"), B.x + r * 0.5, B.y - r * 0.22);
    put(v("vnOnlyC"), C.x, C.y + r * 0.55);
    put(v("vnAB"), mid(A, B).x, mid(A, B).y - r * 0.36);
    put(v("vnAC"), mid(A, C).x - r * 0.3, mid(A, C).y + r * 0.14);
    put(v("vnBC"), mid(B, C).x + r * 0.3, mid(B, C).y + r * 0.14);
    put(v("vnABC"), centre.x, centre.y);
  }
  put(v("vnOutside"), bx + bw - 34, by + bh - 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}

/* ---------------- table ----------------
   The dialog preview only. A table is placed as a live object rather than an image (see
   js/table-obj.js), so this renders the very object that will be inserted — which is the only way
   the preview and the result cannot drift apart, and the reason the preview can be typed into and
   have rows added to it directly. */
function buildTableSvg() { return tableEditorSvg(tableDraftForDialog()); }

/* ---------------- branch probabilities as exact numbers ----------------
   A tree diagram exists to be multiplied along. Doing that in decimals would answer 3/5 × 3/5 with
   0.36, which is not the answer to the question that was asked — so a probability written as a
   fraction is kept as one, and only arithmetic on a decimal produces a decimal.

   `exact` records whether every factor so far was written as a fraction or whole number. One
   decimal anywhere makes the product a decimal, which is the honest thing: 0.3 is not 3/10 to a
   class that has just been told to leave answers as fractions. */
function probFraction(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const frac = /^(-?\d+)\s*\/\s*(-?\d+)$/.exec(s);
  if (frac && +frac[2] !== 0) return { n: +frac[1], d: +frac[2], exact: true };
  const pct = /^(-?[\d.]+)\s*%$/.exec(s);
  if (pct && Number.isFinite(+pct[1])) return { n: +pct[1], d: 100, exact: false };
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  // A whole number is exact (a "1" on a certain branch shouldn't decimalise the whole path).
  if (Number.isInteger(v)) return { n: v, d: 1, exact: true };
  // Decimals become a fraction only so the multiplication stays in one form; `exact` remembers
  // that it must not be PRINTED as one.
  const places = (s.split(".")[1] || "").length;
  return { n: Math.round(v * Math.pow(10, places)), d: Math.pow(10, places), exact: false };
}
const probGcd = (a, b) => (b ? probGcd(b, a % b) : Math.abs(a) || 1);
function probMul(a, b) {
  if (!a || !b) return null;
  const g = probGcd(a.n * b.n, a.d * b.d);
  return { n: (a.n * b.n) / g, d: (a.d * b.d) / g, exact: a.exact && b.exact };
}
function probFractionText(f) {
  if (!f) return "";
  if (!f.exact) {
    // Trimmed rather than fixed: 0.25 should not print as 0.2500, and a repeating value has to
    // stop somewhere.
    const v = f.n / f.d;
    return String(Math.round(v * 1e6) / 1e6);
  }
  const neg = (f.n < 0) !== (f.d < 0);
  const n = Math.abs(f.n), d = Math.abs(f.d);
  return d === 1 ? `${neg ? "-" : ""}${n}` : `${neg ? "-" : ""}${n}/${d}`;
}

/* ---------------- tree ----------------
   Stage sizes are given as a list ("2,2" for two coin tosses, "3,3" for the blood-group example),
   which is what decides both the branching and the height: the leaf count is their product, and
   every node sits at the mean height of its own children. */
function buildTreeSvg() {
  const counts = probList($("trStages").value, ["2", "2"])
    .map(s => Math.min(8, Math.max(1, Math.round(probNum(s, 2))))).slice(0, 4);
  const fontSize = Math.max(8, probNum($("trFontSize").value, 22));
  // "B,A,O ; B,A,O" — one group per stage. A single group is reused for every stage, which is the
  // common case (the same outcomes repeated).
  const labelGroups = String($("trLabels").value || "").split(";").map(g => probList(g, []));
  const probGroups = String($("trProbs").value || "").split(";").map(g => probList(g, []));
  const showOutcomes = $("trOutcomes").checked;
  const showProducts = showOutcomes && $("trProducts").checked;
  const branchColour = $("trColour").value || "#2D4E86";
  const groupFor = (groups, stage) => {
    const g = groups.length === 1 ? groups[0] : (groups[stage] || []);
    return g || [];
  };

  const leaves = counts.reduce((a, b) => a * b, 1);
  const rowH = Math.max(fontSize * 1.9, 34);
  const colW = Math.max(150, fontSize * 7);
  const padL = 30, padT = 26;
  const labelW = shapeLabelMetrics("MM", fontSize, SHAPE_LABEL_CSS).w;

  // Build the node tree first: each leaf gets its own row, each parent the mean of its children.
  let nodes = [];      // {stage, x, y, label, prob, path[]}
  let edges = [];      // {x1,y1,x2,y2,prob}
  let rowCursor = 0;
  const build = (stage, path) => {
    if (stage === counts.length) {
      const y = padT + rowCursor * rowH + rowH / 2;
      rowCursor++;
      return y;
    }
    const kids = [];
    for (let i = 0; i < counts[stage]; i++) kids.push({ i, y: build(stage + 1, path.concat(i)) });
    const y = (kids[0].y + kids[kids.length - 1].y) / 2;
    const x = padL + stage * colW;
    for (const k of kids) {
      const kx = padL + (stage + 1) * colW;
      const labels = groupFor(labelGroups, stage), probs = groupFor(probGroups, stage);
      // Start clear of this node's OWN label (the root has none, so it starts almost at the dot)
      // and stop short of the child's, or a branch runs straight through the letter it points at.
      const from = stage === 0 ? x + 8 : x + labelW * 0.62;
      edges.push({ x1: from, y1: y, x2: kx - labelW * 0.62, y2: k.y, prob: probs[k.i] || "" });
      nodes.push({ x: kx, y: k.y, label: labels[k.i] || "", stage: stage + 1, idx: k.i });
    }
    return y;
  };
  const rootY = build(0, []);

  /* Each leaf's outcome and, where every branch on the way to it carried a probability, their
     product. Worked out here rather than at drawing time because the two columns have to be
     MEASURED to be placed — an outcome is as wide as its labels make it ("BAO" for three stages of
     blood groups) and the product sits clear of the widest one. A path with any branch left blank
     gets no product rather than a number quietly computed from the branches that were filled in. */
  const outcomes = [], products = [];
  (function walkLeaves(stage, name, f) {
    if (stage === counts.length) { outcomes.push(name); products.push(probFractionText(f)); return; }
    const labels = groupFor(labelGroups, stage), ps = groupFor(probGroups, stage);
    for (let i = 0; i < counts[stage]; i++) {
      const step = probFraction(ps[i]);
      walkLeaves(stage + 1, name + (labels[i] || ""), f && step ? probMul(f, step) : null);
    }
  })(0, "", { n: 1, d: 1, exact: true });

  const widest = (arr, size, css) => Math.max(0, ...arr.map(s => s ? shapeLabelMetrics(s, size, css).w : 0));
  const outcomeW = showOutcomes ? widest(outcomes, fontSize, SHAPE_LABEL_CSS) + labelW * 0.7 : 0;
  const productW = showProducts ? widest(products, fontSize * 0.9, STAT_PLAIN_CSS) + labelW * 0.4 : 0;
  const W = Math.round(padL + counts.length * colW +
    (showOutcomes ? labelW * 1.6 + outcomeW + productW : labelW * 1.4));
  const H = Math.round(padT * 2 + leaves * rowH);

  let inner = "";
  for (const e of edges) {
    inner += `  <line x1="${pn(e.x1)}" y1="${pn(e.y1)}" x2="${pn(e.x2)}" y2="${pn(e.y2)}" ` +
      `stroke="${branchColour}" stroke-width="2.4" stroke-linecap="round"/>\n`;
    if (e.prob) {
      // Off the middle of the branch, on the side the branch is heading: sibling branches meet at
      // their parent, so two labels both nudged the same way end up almost on top of each other.
      const rises = e.y2 < e.y1 - 1;
      inner += shapeLabelSvg(e.prob, {
        x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 + (rises ? -fontSize * 0.5 : fontSize * 0.95),
        fontSize: fontSize * 0.82, fill: "#4A5568",
        attrs: SHAPE_LABEL_ATTRS.replace('font-weight="bold"', 'font-weight="normal"'),
        cssFont: SHAPE_LABEL_CSS.replace("font-weight:bold;", ""),
      });
    }
  }
  inner += `  <circle cx="${pn(padL)}" cy="${pn(rootY)}" r="4" fill="${branchColour}"/>\n`;
  for (const nd of nodes) {
    inner += shapeLabelSvg(nd.label, { x: nd.x, y: nd.y + fontSize * 0.35, fontSize, fill: PROB_INK,
      attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS });
  }
  if (showOutcomes) {
    const leafNodes = nodes.filter(n => n.stage === counts.length).sort((a, b) => a.y - b.y);
    const outX = padL + counts.length * colW + labelW * 1.6;
    leafNodes.forEach((n, i) => {
      inner += shapeLabelSvg(outcomes[i] || "", {
        x: outX, y: n.y + fontSize * 0.35,
        fontSize, anchor: "start", fill: "#4A5568", attrs: SHAPE_LABEL_ATTRS, cssFont: SHAPE_LABEL_CSS,
      });
      if (showProducts && products[i]) inner += shapeLabelSvg(products[i], {
        x: outX + outcomeW, y: n.y + fontSize * 0.35, fontSize: fontSize * 0.9,
        anchor: "start", fill: "#4A5568", attrs: STAT_PLAIN_ATTRS, cssFont: STAT_PLAIN_CSS,
      });
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n${inner}</svg>`;
}
