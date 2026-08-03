"use strict";
const PDF_TEXT_SUBST = {
  "θ": "theta", "π": "pi", "α": "alpha", "β": "beta", "γ": "gamma",
  "δ": "delta", "Δ": "Delta", "φ": "phi", "ψ": "psi", "ω": "omega",
  "μ": "mu", "λ": "lambda", "Σ": "Sigma", "Ω": "Omega",
  "√": "sqrt", "∞": "inf", "≈": "~=", "≠": "!=",
  "≤": "<=", "≥": ">=", "×": "x", "÷": "/",
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
  // Superscript/subscript digits and signs — WinAnsi/Helvetica has no true superscript glyphs, so
  // these degrade to plain-ASCII equivalents (e.g. "h⁻¹" -> "h-1") instead of "?". Common in units
  // and exponents copied in from elsewhere (km h⁻¹, x², 10⁻³, H₂O).
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁻": "-", "⁺": "+", "⁼": "=", "⁽": "(", "⁾": ")", "ⁿ": "n", "ⁱ": "i",
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "₋": "-", "₊": "+", "₌": "=", "₍": "(", "₎": ")",
  "\t": "    ",
};
function sanitizeForWinAnsi(str) {
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    // WinAnsiEncoding (cp1252) matches Unicode directly across 0x20-0x7E and 0xA0-0xFF
    // (e.g. the degree sign ° = U+00B0 = byte 0xB0), so those pass straight through.
    if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF)) { out += ch; continue; }
    out += PDF_TEXT_SUBST[ch] ?? "?"; // "?" — genuinely unmappable character
  }
  return out;
}
function dataURLToBytes(dataURL) {
  const bin = atob(dataURL.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

async function exportPdf(pages) {
  pages = (pages && pages.length) ? pages : Array.from({ length: S.pages }, (_, i) => i);
  let PDFLib;
  try { PDFLib = await loadPdfLib(); } catch (err) { notifyDialog("PDF export unavailable", err.message); return; }
  const {
    PDFDocument, StandardFonts, rgb,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix,
    moveTo, lineTo, stroke, setLineWidth, setLineCap, setLineJoin,
    setStrokingColor, setGraphicsState,
  } = PDFLib;
  const PT = 0.75;
  const N = pages.length;

  const pdfDoc = await PDFDocument.create();
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  // All of these are standard 14 PDF fonts — no embedding cost, always available in any PDF
  // viewer — so it's cheap to have every bold/italic variant ready rather than embedding on
  // first use. Keyed [family][bold][italic] so pdfFontFor() below can pick the right one for
  // whatever a [b]/[i] run (see splitFormatRuns, js/math-typeset.js) needs.
  const pdfFonts = {
    Helvetica: {
      false: { false: helv, true: await pdfDoc.embedFont(StandardFonts.HelveticaOblique) },
      true: { false: await pdfDoc.embedFont(StandardFonts.HelveticaBold), true: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique) },
    },
    TimesRoman: {
      false: { false: await pdfDoc.embedFont(StandardFonts.TimesRoman), true: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic) },
      true: { false: await pdfDoc.embedFont(StandardFonts.TimesRomanBold), true: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic) },
    },
    Courier: {
      false: { false: await pdfDoc.embedFont(StandardFonts.Courier), true: await pdfDoc.embedFont(StandardFonts.CourierOblique) },
      true: { false: await pdfDoc.embedFont(StandardFonts.CourierBold), true: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique) },
    },
  };
  const pdfFontFor = (t, bold = false, italic = false) =>
    pdfFonts[(FONT_STACKS[t.font] || FONT_STACKS[DEFAULT_FONT_KEY]).pdf][bold][italic];
  // Mirrors wrapParagraph()'s greedy word-wrap but measures with pdf-lib's font metrics instead
  // of a canvas context, and operates on the already WinAnsi-sanitized text (the substituted
  // ASCII stand-ins for e.g. "θ" render at a different width than the glyph they replace).
  // Same atom rule as the canvas (js/state.js): a "$...$" run is never split, because each half
  // would lose its matching delimiter and export as raw LaTeX. Math is measured by its source
  // width here rather than its rendered width -- an overestimate, so a line may break slightly
  // early, but it can never split a formula, which is the failure that actually matters.
  function wrapParagraphPdf(font, text, maxWidth, size) {
    if (!text) return [""];
    const lines = [];
    let cur = "", curW = 0;
    const widthOf = s => { try { return font.widthOfTextAtSize(s, size); } catch (_) { return 0; } };
    for (const a of textAtoms(text)) {
      if (!cur && a.space) continue;
      const w = widthOf(a.s);
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
  // Shared ExtGState for highlighter alpha, registered once per page as it's drawn (PDF
  // resource names are scoped per-page, but the underlying dictionary object is shared).
  const hlGsRef = pdfDoc.context.register(pdfDoc.context.obj({ Type: "ExtGState", ca: HL_ALPHA, CA: HL_ALPHA }));

  // Source PDFs get parsed once each and cached for the life of this export call, keyed by the
  // id stamped on doc.images at import time; embedded (possibly cropped) pages are cached too
  // so re-copies of the same crop don't re-embed duplicate XObjects.
  const srcDocCache = new Map(); // srcId -> Promise<PDFDocument|null>
  function getSrcDoc(srcId) {
    if (!srcDocCache.has(srcId)) {
      const bytes = pdfSources.get(srcId);
      srcDocCache.set(srcId, bytes ? PDFDocument.load(bytes).catch(() => null) : Promise.resolve(null));
    }
    return srcDocCache.get(srcId);
  }
  const embeddedPageCache = new Map(); // "srcId|pageIndex|box" -> Promise<PDFEmbeddedPage|null>
  function getEmbeddedPage(im) {
    const box = im.pdfWholePage ? null : im.pdfBox;
    const key = `${im.pdfSrcId}|${im.pdfPageIndex}|${box ? [box.left, box.bottom, box.right, box.top].join(",") : ""}`;
    if (!embeddedPageCache.has(key)) {
      embeddedPageCache.set(key, (async () => {
        const srcDoc = await getSrcDoc(im.pdfSrcId);
        const srcPage = srcDoc?.getPages()[im.pdfPageIndex];
        if (!srcPage) return null;
        return pdfDoc.embedPage(srcPage, box || undefined);
      })().catch(() => null));
    }
    return embeddedPageCache.get(key);
  }
  // Raster fallback for anything without usable vector provenance (pasted images, SVG-backed
  // Math Shape Importer shapes, or a PDF-sourced image whose source bytes didn't come through).
  const rasterCache = new Map(); // im -> Promise<PDFEmbeddedImage>
  function getRasterImage(im) {
    if (!rasterCache.has(im)) {
      rasterCache.set(im, (async () => {
        // Shapes generated by the Math Shape Importer are SVG-backed — their intrinsic pixel
        // size is tiny (sized to their cropped bounding box, unrelated to how big they're placed
        // on the page), so re-rasterize those at several times their placed size for a crisp
        // print result instead of baking down to that small native size and stretching it back up.
        const isSvg = typeof im.data === "string" && im.data.startsWith("data:image/svg+xml");
        const RASTER_SCALE = 4;
        const w = isSvg ? Math.max(1, Math.round(im.w * RASTER_SCALE)) : Math.max(1, im.img.naturalWidth);
        const h = isSvg ? Math.max(1, Math.round(im.h * RASTER_SCALE)) : Math.max(1, im.img.naturalHeight);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const cctx = c.getContext("2d");
        if (isSvg) {
          // Left transparent (not white-filled): embedPng keeps the alpha channel natively,
          // so shapes no longer need an opaque white box behind them.
          cctx.drawImage(im.img, 0, 0, w, h);
          return pdfDoc.embedPng(dataURLToBytes(c.toDataURL("image/png")));
        }
        cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, w, h);
        cctx.drawImage(im.img, 0, 0, w, h);
        return pdfDoc.embedJpg(dataURLToBytes(c.toDataURL("image/jpeg", 0.88)));
      })());
    }
    return rasterCache.get(im);
  }

  // Rendered inline-math spans (see math-typeset.js) are already a stable PNG data URL keyed by
  // their own (source, size, color) -- de-dupe on that so the same "$v=d/t$" appearing on several
  // lines only gets embedded as one XObject instead of once per occurrence.
  const mathImageCache = new Map(); // dataURL -> Promise<PDFEmbeddedImage>
  function getMathPdfImage(span) {
    if (!mathImageCache.has(span.dataURL)) mathImageCache.set(span.dataURL, pdfDoc.embedPng(dataURLToBytes(span.dataURL)));
    return mathImageCache.get(span.dataURL);
  }

  // Places an embedded XObject at world rect (im.x,im.y,im.w,im.h). Delegates the actual
  // placement to pdf-lib's own drawPage/drawImage (x,y = bottom-left corner, width/height in
  // points) rather than a hand-rolled `cm` matrix — embedPage's Form XObjects aren't simply
  // unit-square-normalized like raster images (their BBox/Matrix relationship depends on the
  // source page's own box in ways pdf-lib reconciles internally), so re-deriving that placement
  // math externally is fragile; pdf-lib's own tested methods get it right unconditionally.
  // Rotation/flip (rare for PDF-sourced content) is layered on as an outer transform around the
  // target box's own center, wrapping the otherwise-unrotated placement call.
  function drawXObject(page, embedded, im, top, phPt, isForm) {
    const rot = im.rot || 0, phi = -rot;
    const hasTransform = !!(rot || im.flipX || im.flipY);
    const drawOpts = { x: im.x * PT, y: phPt - (im.y + im.h - top) * PT, width: im.w * PT, height: im.h * PT };
    if (hasTransform) {
      const ccx = (im.x + im.w / 2) * PT, ccy = phPt - (im.y + im.h / 2 - top) * PT;
      const cf = Math.cos(phi), sf = Math.sin(phi);
      const sx = im.flipX ? -1 : 1, sy = im.flipY ? -1 : 1;
      const a = cf * sx, b = sf * sx, c = -sf * sy, d = cf * sy;
      const e = ccx - (a * ccx + c * ccy), f = ccy - (b * ccx + d * ccy);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
    }
    if (isForm) page.drawPage(embedded, drawOpts);
    else page.drawImage(embedded, drawOpts);
    if (hasTransform) page.pushOperators(popGraphicsState());
  }

  for (let i = 0; i < N; i++) {
    const srcP = pages[i];
    const dims = pageDims(srcP);
    const phPt = dims.h * PT, pwPt = dims.w * PT;
    const top = srcP * stride(), bot = top + dims.h;
    const X = x => x * PT;
    const Y = y => phPt - (y - top) * PT;
    const page = pdfDoc.addPage([pwPt, phPt]);
    const hlGs = page.node.newExtGState("GShl", hlGsRef);
    page.pushOperators(setLineCap(1), setLineJoin(1));

    for (const im of doc.images) {
      if (im.del || !isLayerVisible(im.layer)) continue;
      const imgP = Math.max(0, Math.min(S.pages - 1, Math.floor(im.y / stride())));
      if (imgP !== srcP) continue;
      let embedded = im.pdfSrcId != null ? await getEmbeddedPage(im) : null;
      let isForm = !!embedded;
      if (!embedded) { embedded = await getRasterImage(im).catch(() => null); isForm = false; }
      if (!embedded) continue;
      drawXObject(page, embedded, im, top, phPt, isForm);
    }

    for (const pass of ["hl", "pen"]) {
      for (const s of doc.strokes) {
        if (s.del || s.tool !== pass || s.pts.length < 2 || !isLayerVisible(s.layer)) continue;
        if (s.pts[0].y < top || s.pts[0].y >= bot) continue;
        const [r, g, b] = hexToRgb01(s.color);
        if (pass === "hl") {
          const w = halfWidth(s) * 2 * PT;
          const ops = [pushGraphicsState(), setGraphicsState(hlGs), setStrokingColor(rgb(r, g, b)), setLineWidth(w), moveTo(X(s.pts[0].x), Y(s.pts[0].y))];
          for (let k = 1; k < s.pts.length; k++) ops.push(lineTo(X(s.pts[k].x), Y(s.pts[k].y)));
          ops.push(stroke(), popGraphicsState());
          page.pushOperators(...ops);
          continue;
        }
        // Pen strokes render with a per-point, pressure-varying width on the canvas (see
        // halfWidth()/drawInk() above in render.js) -- a single flat line width for the whole
        // stroke always mismatches somewhere (previously a constant s.w * 1.15, which read
        // noticeably bolder than lighter/tapered sections of the actual on-screen ink). Drawn
        // per-segment instead, each with its own width from the same halfWidth() formula the
        // canvas uses, averaged across the segment's two endpoint pressures.
        for (let k = 1; k < s.pts.length; k++) {
          const avgP = ((s.pts[k - 1].p ?? 0.5) + (s.pts[k].p ?? 0.5)) / 2;
          const w = halfWidth(s, avgP) * 2 * PT;
          page.pushOperators(
            pushGraphicsState(), setStrokingColor(rgb(r, g, b)), setLineWidth(w),
            moveTo(X(s.pts[k - 1].x), Y(s.pts[k - 1].y)), lineTo(X(s.pts[k].x), Y(s.pts[k].y)),
            stroke(), popGraphicsState(),
          );
        }
      }
    }

    for (const t of doc.texts) {
      if (t.del || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
      const [r, g, b] = hexToRgb01(t.color);
      const font = pdfFontFor(t);
      const paras = (t.lines.length ? t.lines : [""]).map(sanitizeForWinAnsi);
      const lines = t.w ? paras.flatMap(p => wrapParagraphPdf(font, p, t.w * PT, t.size * PT)) : paras;
      const ascent = pdfAscentFor(t);
      for (let k = 0; k < lines.length; k++) {
        const ln = lines[k];
        // t.y + k*size*1.3 is the world-space TOP of this line, matching drawTexts()'s
        // textBaseline:"top" canvas rendering exactly; + size*ascent converts that top position
        // into this font's actual baseline, which is what PDF text drawing positions from.
        const baseline = t.y + k * t.size * 1.3 + t.size * ascent;
        if (!lineNeedsMathPass(ln) && !lineHasFormatting(ln)) {
          page.drawText(ln, { x: X(t.x), y: Y(baseline), size: t.size * PT, font, color: rgb(r, g, b) });
          continue;
        }
        let curX = t.x; // world-space cursor, same units as t.x
        for (const run of splitMathRuns(ln)) {
          if (run.text !== undefined) {
            for (const fr of splitFormatRuns(run.text)) {
              const frFont = pdfFontFor(t, fr.bold, fr.italic);
              page.drawText(fr.text, { x: X(curX), y: Y(baseline), size: t.size * PT, font: frFont, color: rgb(r, g, b) });
              const w = frFont.widthOfTextAtSize(fr.text, t.size);
              if (fr.underline) {
                // No native underline in pdf-lib's drawText -- a thin rectangle just below the
                // baseline, same idea as the manual stroke drawTexts() (render.js) already draws
                // on canvas for the same reason. drawRectangle anchors its bottom-left corner with
                // height extending toward smaller world-y (up the page), so the anchor needs to be
                // the stroke's BOTTOM edge in world space (baseline + offset + thickness), not its top.
                const thickness = Math.max(0.6, t.size * 0.05);
                const strokeBottomWorld = baseline + t.size * 0.08 + thickness;
                page.drawRectangle({ x: X(curX), y: Y(strokeBottomWorld), width: w * PT, height: thickness * PT, color: rgb(r, g, b) });
              }
              curX += w;
            }
            continue;
          }
          const span = await getMathSpanAsync(run.math, mathSizePx(t.size), t.color);
          if (span && span.dataURL && !span.failed) {
            const pngImg = await getMathPdfImage(span);
            const imgBottomWorld = baseline + span.baselineOffset + span.h;
            page.drawImage(pngImg, { x: X(curX), y: Y(imgBottomWorld), width: span.w * PT, height: span.h * PT });
            curX += span.w;
          } else {
            const raw = `$${run.math}$`;
            page.drawText(raw, { x: X(curX), y: Y(baseline), size: t.size * PT, font, color: rgb(r, g, b) });
            curX += font.widthOfTextAtSize(raw, t.size);
          }
        }
      }
    }

    for (const t of doc.tapes) {
      if (t.del || t.revealed || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
      const [tr, tg, tb] = hexToRgb01(t.color || "#FFD682");
      page.drawRectangle({ x: X(t.x), y: Y(t.y + t.h), width: t.w * PT, height: t.h * PT, color: rgb(tr, tg, tb) });
    }
  }

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "notes.pdf";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- SVG export ----------------
   One standalone <svg> document per selected page, built directly from doc.* rather than going
   through pdf-lib. Unlike the PDF path (standard-14 fonts, WinAnsi-only, so "θ" degrades to
   "theta"), SVG <text> is plain Unicode -- symbols, Greek letters, sub/superscript digits etc.
   come through as-is, and strokes are built the same way drawInk() builds them on the canvas
   (a real filled, pressure-varying polygon) rather than the PDF path's flat-per-segment lines. */
function svgImageEl(im, top) {
  const localY = im.y - top;
  const href = im.data;
  if (im.rot || im.flipX || im.flipY) {
    const cx = im.x + im.w / 2, cy = localY + im.h / 2;
    const deg = (im.rot || 0) * 180 / Math.PI;
    const sx = im.flipX ? -1 : 1, sy = im.flipY ? -1 : 1;
    return `<image href="${href}" xlink:href="${href}" x="${-im.w / 2}" y="${-im.h / 2}" width="${im.w}" height="${im.h}" transform="translate(${cx} ${cy}) rotate(${deg}) scale(${sx} ${sy})"/>\n`;
  }
  return `<image href="${href}" xlink:href="${href}" x="${im.x}" y="${localY}" width="${im.w}" height="${im.h}"/>\n`;
}
// Mirrors pathThrough() in render.js (a smooth path through points via quadratic curves to each
// pair's midpoint) but emits an SVG path "d" string in page-local (top-shifted) coordinates
// instead of driving a canvas context.
function svgPathThroughD(pts, top) {
  const ly = p => p.y - top;
  if (pts.length === 1) return `M ${pts[0].x} ${ly(pts[0])} L ${pts[0].x + 0.01} ${ly(pts[0])}`;
  let d = `M ${pts[0].x} ${ly(pts[0])} `;
  for (let i = 1; i < pts.length - 1; i++) {
    const m = midpoint(pts[i], pts[i + 1]);
    d += `Q ${pts[i].x} ${ly(pts[i])} ${m.x} ${ly(m)} `;
  }
  const last = pts[pts.length - 1];
  d += `L ${last.x} ${ly(last)}`;
  return d;
}
// Mirrors drawInk() in render.js: a highlighter stroke is a simple translucent stroked path; a
// pen stroke with 3+ points is a filled shape built from per-point pressure-varying offsets, with
// round end caps -- so the exported vector matches what's actually on screen.
function svgStrokeEl(s, top) {
  const pts = s.pts;
  if (s.tool === "hl") {
    const w = halfWidth(s) * 2;
    return `<path d="${svgPathThroughD(pts, top)}" fill="none" stroke="${s.color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${HL_ALPHA}"/>\n`;
  }
  if (pts.length < 3) {
    const w = halfWidth(s, pts[0].p) * 2;
    return `<path d="${svgPathThroughD(pts, top)}" fill="none" stroke="${s.color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>\n`;
  }
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    const h = halfWidth(s, pts[i].p);
    nx = nx / len * h; ny = ny / len * h;
    L.push({ x: pts[i].x + nx, y: pts[i].y - top + ny });
    R.push({ x: pts[i].x - nx, y: pts[i].y - top - ny });
  }
  let d = `M ${L[0].x} ${L[0].y} `;
  for (let i = 1; i < L.length - 1; i++) {
    const m = { x: (L[i].x + L[i + 1].x) / 2, y: (L[i].y + L[i + 1].y) / 2 };
    d += `Q ${L[i].x} ${L[i].y} ${m.x} ${m.y} `;
  }
  d += `L ${L[L.length - 1].x} ${L[L.length - 1].y} L ${R[R.length - 1].x} ${R[R.length - 1].y} `;
  for (let i = R.length - 2; i > 0; i--) {
    const m = { x: (R[i].x + R[i - 1].x) / 2, y: (R[i].y + R[i - 1].y) / 2 };
    d += `Q ${R[i].x} ${R[i].y} ${m.x} ${m.y} `;
  }
  d += `L ${R[0].x} ${R[0].y} Z`;
  const s0 = pts[0], eN = pts[pts.length - 1];
  return `<path d="${d}" fill="${s.color}"/>\n` +
    `<circle cx="${s0.x}" cy="${s0.y - top}" r="${halfWidth(s, s0.p)}" fill="${s.color}"/>\n` +
    `<circle cx="${eN.x}" cy="${eN.y - top}" r="${halfWidth(s, eN.p)}" fill="${s.color}"/>\n`;
}
async function svgTextEl(t, top) {
  const ascent = pdfAscentFor(t);
  // fontCss(t) is a CSS stack with "quoted" family names -- swap to single quotes so it doesn't
  // clash with the double-quoted attribute it's embedded in below.
  const family = fontCss(t).replace(/"/g, "'");
  measureCtx.font = `${t.size}px ${fontCss(t)}`;
  let out = "";
  const lines = wrappedLines(t);
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k];
    if (!ln) continue;
    const baseline = t.y - top + k * t.size * 1.3 + t.size * ascent;
    if (!lineNeedsMathPass(ln) && !lineHasFormatting(ln)) {
      out += `<text x="${t.x}" y="${baseline}" font-family="${family}" font-size="${t.size}" fill="${t.color}">${escapeXml(ln)}</text>\n`;
      continue;
    }
    let curX = t.x;
    for (const run of splitMathRuns(ln)) {
      if (run.text !== undefined) {
        for (const fr of splitFormatRuns(run.text)) {
          const style = `${fr.bold ? ' font-weight="bold"' : ""}${fr.italic ? ' font-style="italic"' : ""}${fr.underline ? ' text-decoration="underline"' : ""}`;
          out += `<text x="${curX}" y="${baseline}" font-family="${family}" font-size="${t.size}" fill="${t.color}"${style}>${escapeXml(fr.text)}</text>\n`;
          measureCtx.font = `${fr.italic ? "italic " : ""}${fr.bold ? "bold " : ""}${t.size}px ${fontCss(t)}`;
          curX += measureCtx.measureText(fr.text).width;
        }
        continue;
      }
      measureCtx.font = `${t.size}px ${fontCss(t)}`; // reset -- a preceding formatted run may have left bold/italic set
      const span = await getMathSpanAsync(run.math, mathSizePx(t.size), t.color);
      if (span && span.dataURL && !span.failed) {
        const imgTop = baseline + span.baselineOffset;
        out += `<image href="${span.dataURL}" xlink:href="${span.dataURL}" x="${curX}" y="${imgTop}" width="${span.w}" height="${span.h}"/>\n`;
        curX += span.w;
      } else {
        const raw = `$${run.math}$`;
        out += `<text x="${curX}" y="${baseline}" font-family="${family}" font-size="${t.size}" fill="${t.color}">${escapeXml(raw)}</text>\n`;
        curX += measureCtx.measureText(raw).width;
      }
    }
  }
  return out;
}
async function buildPageSvg(srcP) {
  const dims = pageDims(srcP);
  const top = srcP * stride(), bot = top + dims.h;
  let body = `<rect x="0" y="0" width="${dims.w}" height="${dims.h}" fill="#fff"/>\n`;

  for (const im of doc.images) {
    if (im.del || !isLayerVisible(im.layer)) continue;
    const imgP = Math.max(0, Math.min(S.pages - 1, Math.floor(im.y / stride())));
    if (imgP !== srcP) continue;
    body += svgImageEl(im, top);
  }

  for (const pass of ["hl", "pen"]) {
    for (const s of doc.strokes) {
      if (s.del || s.tool !== pass || s.pts.length < 2 || !isLayerVisible(s.layer)) continue;
      if (s.pts[0].y < top || s.pts[0].y >= bot) continue;
      body += svgStrokeEl(s, top);
    }
  }

  for (const t of doc.texts) {
    if (t.del || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
    body += await svgTextEl(t, top);
  }

  for (const t of doc.tapes) {
    if (t.del || t.revealed || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
    body += `<rect x="${t.x}" y="${t.y - top}" width="${t.w}" height="${t.h}" fill="${t.color || "#FFD682"}"/>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${dims.w}" height="${dims.h}" viewBox="0 0 ${dims.w} ${dims.h}">\n${body}</svg>`;
}
async function exportSvg(pages) {
  pages = (pages && pages.length) ? pages : Array.from({ length: S.pages }, (_, i) => i);
  // SVG has no native multi-page container, so multiple selected pages come out as one file per
  // page instead of one combined document -- staggered slightly so Chrome's multi-download
  // permission prompt (which only appears once) doesn't drop any of them.
  for (let i = 0; i < pages.length; i++) {
    const blob = new Blob([await buildPageSvg(pages[i])], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = pages.length > 1 ? `notes-page${pages[i] + 1}.svg` : "notes.svg";
    a.click();
    URL.revokeObjectURL(a.href);
    if (i < pages.length - 1) await new Promise(res => setTimeout(res, 150));
  }
}

/* ============================================================================
   UI — toolbar, palette pop-out, sidebar, shortcuts, boot
   ========================================================================== */
