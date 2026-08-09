"use strict";
/* ============================================================================
   Inline math typesetting -- "$...$" spans inside text boxes, rendered with KaTeX.
   ========================================================================== */
const KATEX_VERSION = "0.16.11";
const KATEX_BASE = `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/${KATEX_VERSION}/`;

let katexReady = null;
function loadKatex() {
  if (katexReady) return katexReady;
  katexReady = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = KATEX_BASE + "katex.min.js";
    sc.onload = () => res(window.katex);
    sc.onerror = () => { katexReady = null; rej(new Error("Could not load the math engine.")); };
    document.head.appendChild(sc);
  });
  return katexReady;
}

// A copy of katex.min.css with every referenced .woff2 font inlined as a base64 data: URI. Needed
// so the SVG <foreignObject> we rasterize each math span into has zero cross-origin resource
// loads -- without this, drawing that rasterized result onto a canvas taints it (blocks the
// toDataURL() calls both the live canvas and the PDF/SVG export paths need) even though it would
// look fine visually either way. Fetched and built once, then reused for every span.
let inlinedCssReady = null;
function loadInlinedKatexCss() {
  if (inlinedCssReady) return inlinedCssReady;
  inlinedCssReady = (async () => {
    let css = await (await fetch(KATEX_BASE + "katex.min.css")).text();
    const urls = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
    await Promise.all(urls.map(async u => {
      const bytes = new Uint8Array(await (await fetch(KATEX_BASE + u)).arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      css = css.split(`url(${u})`).join(`url(data:font/woff2;base64,${btoa(bin)})`);
    }));
    return css;
  })().catch(err => { inlinedCssReady = null; throw err; });
  return inlinedCssReady;
}

// One hidden, attached DOM node reused for every measurement pass (attached, not display:none --
// getBoundingClientRect needs real layout).
let measureHost = null;
function getMeasureHost() {
  if (measureHost) return measureHost;
  measureHost = document.createElement("div");
  measureHost.style.cssText = "position:fixed; left:-99999px; top:0; visibility:hidden; white-space:nowrap;";
  document.body.appendChild(measureHost);
  return measureHost;
}
// Serializes access to the shared measuring host -- see the big comment at its call site in
// renderMathSpan() for why this is needed.
let measureQueue = Promise.resolve();
function withMeasureLock(fn) {
  const result = measureQueue.then(fn, fn);
  measureQueue = result.catch(() => {});
  return result;
}

/* ---------------- "$...$" parsing ---------------- */
// Splits a line into alternating {text} / {math} segments. "\$" escapes a literal dollar sign
// (e.g. "cost: \$5"). An unterminated "$" (no matching close before end of line) is kept as a
// literal character rather than silently swallowing the rest of the line.
function splitMathRuns(line) {
  if (!line.includes("$")) return [{ text: line }];
  const runs = [];
  let buf = "", i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "$") { buf += "$"; i += 2; continue; }
    if (ch === "$") {
      // Delimiters must "hug" their content: an opening $ is followed by a non-space, a closing $
      // is preceded by a non-space. This is the usual convention (Markdown/MathJax do the same) and
      // it's what stops ordinary prose about money turning into math: in "earns $500 per week plus
      // $10", the second $ has a space before it, so it isn't a valid closer, nothing else closes
      // the first one, and the whole thing stays literal text. Real math ("$x^2$") is unaffected,
      // and "\$" still works for the cases this heuristic can't win (e.g. "$5 and $6").
      if (/\s/.test(line[i + 1] || "")) { buf += ch; i++; continue; }
      let close = -1;
      for (let j = i + 1; j < line.length; j++) {
        if (line[j] !== "$" || line[j - 1] === "\\") continue;
        if (/\s/.test(line[j - 1])) continue; // space before the closer -- not a delimiter
        close = j; break;
      }
      if (close === -1) { buf += ch; i++; continue; }
      const src = line.slice(i + 1, close);
      if (!src) { buf += "$$"; i = close + 1; continue; } // "$$" (empty) -- nothing to render
      if (buf) { runs.push({ text: buf }); buf = ""; }
      runs.push({ math: src });
      i = close + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) runs.push({ text: buf });
  return runs;
}
// True as soon as a line contains a real (non-escaped) "$" pair -- lets callers skip the
// run-splitting machinery entirely for the overwhelming majority of plain-text lines.
function lineHasMath(line) { return splitMathRuns(line).some(r => r.math !== undefined); }
// Whether a line must go through splitMathRuns() before being drawn, as opposed to being drawn
// verbatim. Broader than lineHasMath on purpose: a line with only ESCAPED dollars ("\$500") has no
// math runs at all, but still needs the pass, because the unescaping to a bare "$" happens inside
// it. Taking the verbatim fast path there is what printed the backslashes to screen and to PDF.
function lineNeedsMathPass(line) { return line.includes("$"); }

/* ---------------- "[b]...[/b]" / "[i]...[/i]" / "[u]...[/u]" parsing ----------------
   Inline bold/italic/underline, toggled from the text-format toolbar (see toggleInlineFormat()
   in js/text-edit.js) rather than typed by hand -- BBCode-style bracket tags rather than
   markdown's asterisk/underscore markers specifically because those characters already appear
   inside ordinary math source ($a \times b$, $x_1$) that this has to coexist with; the bracket
   tags never collide with LaTeX syntax the same way. Only runs through the TEXT portions coming
   out of splitMathRuns() above -- math runs are opaque to this and never re-parsed. Combining
   all three just nests the tags, e.g. "[b][i]both[/i][/b]". */
const FORMAT_TAG_KEYS = { b: "bold", i: "italic", u: "underline" };
const FORMAT_TAG_RE = /^\[(\/?)(b|i|u)\]/;
function splitFormatRuns(text) {
  if (!/\[\/?[biu]\]/.test(text)) return [{ text, bold: false, italic: false, underline: false }];
  const runs = [];
  const state = { bold: false, italic: false, underline: false };
  let buf = "", i = 0;
  const flush = () => { if (buf) { runs.push({ text: buf, ...state }); buf = ""; } };
  while (i < text.length) {
    const m = FORMAT_TAG_RE.exec(text.slice(i));
    if (m) { flush(); state[FORMAT_TAG_KEYS[m[2]]] = m[1] !== "/"; i += m[0].length; continue; }
    buf += text[i]; i++;
  }
  flush();
  return runs;
}
function lineHasFormatting(line) { return /\[\/?[biu]\]/.test(line); }

/* ---------------- render + cache ---------------- */
// KaTeX's own math font reads visibly larger than a plain sans-serif line of text at the same
// nominal font size (bigger x-height/cap-height for its glyphs, plus TeX's own sizing
// conventions for stacked constructs like fractions) -- scaling down the size actually requested
// from KaTeX closes most of that gap without touching the surrounding text's own size at all.
// Applied once here (mathSizePx), used by every getMathSpan/getMathSpanAsync call site (canvas,
// PDF, SVG) so all three stay visually consistent with each other.
const MATH_SIZE_SCALE = 0.82;
function mathSizePx(textSize) { return textSize * MATH_SIZE_SCALE; }
// Keyed by world-space (zoom-independent) font size, matching how the canvas already draws
// doc.images at a world-space w/h scaled by V.zoom -- avoids re-rendering on every zoom tick.
const mathSpanCache = new Map(); // key -> {img, w, h, dataURL, baselineOffset, failed} | Promise
function mathCacheKey(src, sizePx, color) { return `${src} ${sizePx} ${color}`; }

async function renderMathSpan(src, sizePx, color) {
  const katex = await loadKatex();
  const inlinedCss = await loadInlinedKatexCss();

  let html;
  try { html = katex.renderToString(src, { throwOnError: false, displayMode: false }); }
  catch (err) { html = `<span style="color:#C0392B">[math error]</span>`; }

  // getMeasureHost() is one shared, reused DOM node -- renderMathSpan() is async with a real
  // await in the middle (document.fonts.ready), and drawTexts() typically kicks off several
  // spans in the same synchronous pass, so without serializing access here two concurrent
  // renders stomp on each other's host.innerHTML mid-measurement (one only ever measures
  // whichever span most recently overwrote the shared host).
  // The exact markup the foreignObject rasterization below wraps the KaTeX output in --
  // display:inline-block + line-height:normal, needed there so it renders at its full natural
  // size inside the SVG's isolated document (a plain inline span there ends up shorter, since it
  // has no ambient line-height/baseline context to size a fraction's stacked numerator/bar/
  // denominator against). Reused verbatim for measurement too (see mathContentStyle below) --
  // measuring under different styling than what actually gets rasterized was exactly the bug: a
  // fraction measured a few pixels short of what it renders at, so the foreignObject (which clips
  // like any overflow:hidden box) cropped the bottom of the denominator off.
  const mathContentStyle = `font-size:${sizePx}px; display:inline-block; line-height:normal;`;
  const { w, h, baselineOffset } = await withMeasureLock(async () => {
    const host = getMeasureHost();
    // A zero-size inline-block sibling with vertical-align:baseline sits with its (zero-height) box
    // exactly on the surrounding text's baseline by CSS definition -- a standard trick for reading
    // out a real baseline position via getBoundingClientRect, without relying on any particular
    // glyph's own metrics (an earlier version measured against a plain "A" character's box bottom,
    // which is the font's *descent* line, not the baseline -- it was consistently off by that gap).
    // The probe is a sibling of the math wrapper (not inside it) so it still measures baseline
    // position in the surrounding text's own line-box context, independent of whatever line-height
    // the math wrapper itself forces for sizing purposes.
    // Uses the SAME already-loaded, self-contained CSS string as the foreignObject rasterization
    // below (rather than a separately CDN-linked stylesheet) so there's no risk of measuring against
    // unstyled/partially-loaded content, and no risk of the two ever drifting out of sync.
    host.innerHTML =
      `<style>${inlinedCss}</style>` +
      `<span style="font-size:${sizePx}px;">` +
      `<span class="ip-probe" style="display:inline-block; width:0; height:0; vertical-align:baseline;"></span>` +
      `<span style="${mathContentStyle}">${html}</span>` +
      `</span>`;
    await document.fonts.ready;
    const probeEl = host.querySelector(".ip-probe");
    const probeRect = probeEl.getBoundingClientRect();
    // katex's root output element sits inside the math wrapper span (the probe's other sibling) --
    // measuring the WRAPPER (not the katex element directly) is what makes this match what the
    // foreignObject below actually rasterizes, since that's the same wrapper it uses too.
    const mathRect = probeEl.nextElementSibling.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(mathRect.width)), h = Math.max(1, Math.ceil(mathRect.height));
    // How far the math box's top sits above/below the true baseline, at this font size (world-space
    // px, zoom-independent).
    const baselineOffset = mathRect.top - probeRect.top;
    host.innerHTML = "";
    return { w, h, baselineOffset };
  });

  const RASTER_SCALE = 3; // supersampled so it stays crisp across normal zoom/export scales
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><style>${inlinedCss}</style>` +
    `<span style="${mathContentStyle} color:${color};">${html}</span>` +
    `</div></foreignObject></svg>`;
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("math render failed"));
    im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup);
  });

  const c = document.createElement("canvas");
  c.width = w * RASTER_SCALE; c.height = h * RASTER_SCALE;
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);

  const entry = { img: c, w, h, baselineOffset, dataURL: c.toDataURL("image/png") };
  mathSpanCache.set(mathCacheKey(src, sizePx, color), entry);
  needsDraw = true;
  return entry;
}

/* ---------------- math as inline SVG, for shape and graph labels ----------------
   Shape labels can't use the raster spans above. A shape is placed as an SVG and stays vector, so
   a PNG label would be the one soft thing on an otherwise crisp diagram — visible as soon as it's
   zoomed or printed. These render the same KaTeX HTML into a <foreignObject> instead, which stays
   real text and scales cleanly.

   The catch is fonts. A shape SVG is placed as a data: URL and loads nothing external, so KaTeX's
   woff2 files have to travel inside it — and all twenty inlined is 361KB per shape. Only the faces
   a formula actually uses are carried, which for ordinary maths is two (KaTeX_Main regular and
   KaTeX_Math italic) and about 74KB. Measured identical on screen to embedding the lot. */

/* The dialog preview is an INLINE svg, so it's part of this document and the page's own stylesheet
   reaches inside its <foreignObject> — measured: an unstyled fraction laid out 127px wide, the
   same one 69px once this is present. So the preview needs no embedded fonts whatsoever, and only
   a shape that leaves as a standalone data: URL has to carry them.
   Uses the string already fetched for the raster spans, so this costs no extra network. */
let katexCssInDocument = false;
function ensureKatexCssInDocument() {
  if (katexCssInDocument) return;
  katexCssInDocument = true;
  loadInlinedKatexCss().then(css => {
    const el = document.createElement("style");
    el.id = "katexInlinedCss";
    el.textContent = css;
    document.head.appendChild(el);
    if (shapeMathOnReady) shapeMathOnReady(); // labels laid out before this need re-measuring
  }).catch(() => { katexCssInDocument = false; });
}

// The inlined stylesheet split into its @font-face rules and everything else, so a caller can
// rebuild it with just the faces it needs.
let katexCssParts = null; // resolved value, for the synchronous accessors below
let katexCssPartsReady = null;
function loadKatexCssParts() {
  if (katexCssPartsReady) return katexCssPartsReady;
  katexCssPartsReady = loadInlinedKatexCss().then(css => {
    katexCssParts = katexCssPartsFromText(css);
    return katexCssParts;
  }).catch(err => { katexCssPartsReady = null; throw err; });
  return katexCssPartsReady;
}
// "400"/"700" rather than "normal"/"bold": getComputedStyle always reports the numeric form, the
// stylesheet uses either, and the two have to compare equal or no face ever matches.
function katexFaceKey(family, weight, style) {
  const w = ({ normal: "400", bold: "700" })[String(weight).trim()] || String(weight).trim();
  return `${String(family).trim()}|${w}|${String(style).trim()}`;
}
/* A notebook's own copy of the stylesheet its graphs need (see serialize/deserialize in
   pages-pdf.js), which is what lets a saved graph render with no network at all.

   It has to be saved, because nothing else caches it: KaTeX comes off a CDN and sw.js never
   touches cross-origin requests, so the fetch above happens fresh every session. Held here rather
   than read out of `doc` so katexCssForFaces stays a plain lookup. */
let katexCssSaved = null; // { base, faces: { faceKey: "@font-face{...}" } } | null
function registerSavedKatexCss(saved) {
  katexCssSaved = saved && typeof saved.base === "string" && saved.faces ? saved : null;
}
// The stylesheet an SVG needs to render the given faces, and nothing more. The live stylesheet
// wins when it's loaded; the notebook's saved copy covers the offline/not-yet-fetched case. "" when
// neither is available — the caller then leaves the shape unstyled and retries (see setShapeImgSrc).
function katexCssForFaces(faceKeys) {
  const src = katexCssParts || katexCssSaved;
  if (!src || !faceKeys || !faceKeys.length) return "";
  return src.base + [...new Set(faceKeys)].map(k => src.faces[k] || "").join("");
}
// The subset a notebook has to carry to stand on its own: the base rules once, plus only the faces
// its own shapes ask for (two, for ordinary maths). Prefers the live stylesheet but falls back to
// what the notebook was opened with, so re-saving an offline session doesn't drop the fonts.
function katexCssBundleFor(faceKeys) {
  const src = katexCssParts || katexCssSaved;
  const keys = [...new Set(faceKeys || [])];
  if (!src || !keys.length) return null;
  const faces = {};
  for (const k of keys) if (src.faces[k]) faces[k] = src.faces[k];
  return Object.keys(faces).length ? { base: src.base, faces } : null;
}
/* Reads a stylesheet back apart into the same { base, faces } shape loadKatexCssParts produces.
   Used to migrate notebooks saved before the fonts were hoisted, which have a full copy embedded
   in every graph — see demoteShapeMathCss. */
function katexCssPartsFromText(css) {
  const faces = {};
  const base = String(css).replace(/@font-face\s*\{[^}]*\}/g, block => {
    const pick = (re, dflt) => {
      const m = block.match(re);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : dflt;
    };
    faces[katexFaceKey(pick(/font-family:\s*([^;}]+)/, ""), pick(/font-weight:\s*([^;}]+)/, "400"),
      pick(/font-style:\s*([^;}]+)/, "normal"))] = block;
    return "";
  });
  return { base, faces };
}

const shapeMathCache = new Map(); // key -> {html, style, w, h, baselineOffset, faceKeys} | Promise
let shapeMathOnReady = null;      // set by the shape dialog, so a finished render redraws its preview
const shapeMathKey = (line, sizePx, cssFont) => `${line} ${sizePx} ${cssFont}`;

/* Renders a WHOLE label, not a single formula: an axis reads "Speed $v$ (m s^{-1})" as often as it
   reads pure maths, and laying text and formulae out side by side is something inline HTML already
   does correctly. cssFont carries the label's own typography (the serif italic of an axis title,
   say) so the prose around the maths still looks like the rest of the diagram. */
async function renderShapeMath(line, sizePx, cssFont) {
  const katex = await loadKatex();
  await loadKatexCssParts();
  const html = splitMathRuns(line).map(r => {
    if (r.math === undefined) return escapeXml(r.text);
    try { return katex.renderToString(r.math, { throwOnError: false, displayMode: false }); }
    catch (_) { return `<span style="color:#C0392B">${escapeXml(r.math)}</span>`; }
  }).join("");

  const style = `font-size:${sizePx}px; display:inline-block; line-height:normal; white-space:pre; ${cssFont || ""}`;
  const measured = await withMeasureLock(async () => {
    const host = getMeasureHost();
    // Measured under the full stylesheet (fonts and all) so the size matches what the subset will
    // actually draw — the subset is chosen FROM this measurement, so it can't be used to take it.
    // The zero-size baseline probe is the same trick renderMathSpan uses — see the long note there
    // for why a glyph's own box is the wrong thing to measure against. Labels need it because an
    // SVG <text> is positioned by its baseline while a <foreignObject> is positioned by its top
    // corner, so placing one where the other would have sat needs that gap.
    host.innerHTML =
      `<style>${await loadInlinedKatexCss()}</style>` +
      `<span style="font-size:${sizePx}px;">` +
      `<span class="ip-probe" style="display:inline-block;width:0;height:0;vertical-align:baseline;"></span>` +
      `<span style="${style}">${html}</span></span>`;
    await document.fonts.ready;
    const probeEl = host.querySelector(".ip-probe");
    const el = probeEl.nextElementSibling;
    const r = el.getBoundingClientRect();
    const baselineOffset = r.top - probeEl.getBoundingClientRect().top;
    // Which faces the browser actually resolved for this formula — read from the live layout
    // rather than guessed from the LaTeX, which would mean reimplementing KaTeX's font choices.
    const faceKeys = new Set();
    for (const node of [el, ...el.querySelectorAll("*")]) {
      const cs = getComputedStyle(node);
      const fam = (cs.fontFamily || "").replace(/["']/g, "").split(",")[0].trim();
      if (fam.toLowerCase().startsWith("katex")) faceKeys.add(katexFaceKey(fam, cs.fontWeight, cs.fontStyle));
    }
    const out = { w: Math.max(1, Math.ceil(r.width)), h: Math.max(1, Math.ceil(r.height)), baselineOffset, faceKeys: [...faceKeys] };
    host.innerHTML = "";
    return out;
  });

  const entry = { html, style, ...measured };
  shapeMathCache.set(shapeMathKey(line, sizePx, cssFont), entry);
  if (shapeMathOnReady) shapeMathOnReady();
  return entry;
}
// Same contract as getMathSpan: starts a render if needed, returns null until it's ready.
function getShapeMath(line, sizePx, cssFont) {
  const key = shapeMathKey(line, sizePx, cssFont);
  const existing = shapeMathCache.get(key);
  if (existing && !(existing instanceof Promise)) return existing;
  if (!existing) {
    shapeMathCache.set(key, renderShapeMath(line, sizePx, cssFont).catch(() => {
      const failed = { html: "", style: "", w: 0, h: 0, baselineOffset: 0, faceKeys: [], failed: true };
      shapeMathCache.set(key, failed);
      if (shapeMathOnReady) shapeMathOnReady();
      return failed;
    }));
  }
  return null;
}
// Waits for a pending render instead of returning null -- for the export paths, which have to have
// every label resolved before they can produce their output.
function getShapeMathAsync(line, sizePx, cssFont) {
  const key = shapeMathKey(line, sizePx, cssFont);
  const existing = shapeMathCache.get(key);
  if (existing instanceof Promise) return existing;
  if (existing) return Promise.resolve(existing);
  getShapeMath(line, sizePx, cssFont);
  return shapeMathCache.get(key);
}

// Kicks off a render if not already cached/in flight (safe to call every draw frame) and returns
// the cached result once ready, or null while still pending/never started.
function getMathSpan(src, sizePx, color) {
  const key = mathCacheKey(src, sizePx, color);
  const existing = mathSpanCache.get(key);
  if (existing && !(existing instanceof Promise)) return existing;
  if (!existing) {
    const p = renderMathSpan(src, sizePx, color).catch(() => {
      const fallback = { img: null, w: 0, h: 0, baselineOffset: 0, dataURL: null, failed: true };
      mathSpanCache.set(key, fallback);
      needsDraw = true;
      return fallback;
    });
    mathSpanCache.set(key, p);
  }
  return null;
}
// Same lookup, but waits for a pending render instead of returning null -- for export paths,
// which need every math span resolved before they can produce their output.
function getMathSpanAsync(src, sizePx, color) {
  const key = mathCacheKey(src, sizePx, color);
  const existing = mathSpanCache.get(key);
  if (existing instanceof Promise) return existing;
  if (existing) return Promise.resolve(existing);
  getMathSpan(src, sizePx, color);
  return mathSpanCache.get(key);
}
