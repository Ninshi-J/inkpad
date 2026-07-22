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
  try { PDFLib = await loadPdfLib(); } catch (err) { alert(err.message); return; }
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
  // All three of these are standard 14 PDF fonts — no embedding cost, always available in any
  // PDF viewer — so it's cheap to have all of them ready rather than embedding on first use.
  const pdfFonts = {
    Helvetica: helv,
    TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    Courier: await pdfDoc.embedFont(StandardFonts.Courier),
  };
  const pdfFontFor = t => pdfFonts[(FONT_STACKS[t.font] || FONT_STACKS[DEFAULT_FONT_KEY]).pdf];
  // Mirrors wrapParagraph()'s greedy word-wrap but measures with pdf-lib's font metrics instead
  // of a canvas context, and operates on the already WinAnsi-sanitized text (the substituted
  // ASCII stand-ins for e.g. "θ" render at a different width than the glyph they replace).
  function wrapParagraphPdf(font, text, maxWidth, size) {
    if (!text) return [""];
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (const word of words) {
      const test = cur ? cur + " " + word : word;
      if (!cur || font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
      else { lines.push(cur); cur = word; }
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
      if (im.del) continue;
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
        if (s.del || s.tool !== pass || s.pts.length < 2) continue;
        if (s.pts[0].y < top || s.pts[0].y >= bot) continue;
        const w = (pass === "hl" ? halfWidth(s) * 2 : s.w * 1.15) * PT;
        const [r, g, b] = hexToRgb01(s.color);
        const ops = [pushGraphicsState()];
        if (pass === "hl") ops.push(setGraphicsState(hlGs));
        ops.push(setStrokingColor(rgb(r, g, b)), setLineWidth(w), moveTo(X(s.pts[0].x), Y(s.pts[0].y)));
        for (let k = 1; k < s.pts.length; k++) ops.push(lineTo(X(s.pts[k].x), Y(s.pts[k].y)));
        ops.push(stroke(), popGraphicsState());
        page.pushOperators(...ops);
      }
    }

    for (const t of doc.texts) {
      if (t.del || t.y < top || t.y >= bot) continue;
      const [r, g, b] = hexToRgb01(t.color);
      const font = pdfFontFor(t);
      const paras = (t.lines.length ? t.lines : [""]).map(sanitizeForWinAnsi);
      const lines = t.w ? paras.flatMap(p => wrapParagraphPdf(font, p, t.w * PT, t.size * PT)) : paras;
      const ascent = pdfAscentFor(t);
      lines.forEach((ln, k) => {
        // t.y + k*size*1.3 is the world-space TOP of this line, matching drawTexts()'s
        // textBaseline:"top" canvas rendering exactly; + size*ascent converts that top position
        // into this font's actual baseline, which is what PDF text drawing positions from.
        page.drawText(ln, {
          x: X(t.x), y: Y(t.y + k * t.size * 1.3 + t.size * ascent),
          size: t.size * PT, font, color: rgb(r, g, b),
        });
      });
    }

    for (const t of doc.tapes) {
      if (t.del || t.revealed || t.y < top || t.y >= bot) continue;
      page.drawRectangle({ x: X(t.x), y: Y(t.y + t.h), width: t.w * PT, height: t.h * PT, color: rgb(1, 0.84, 0.51) });
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

/* ============================================================================
   UI — toolbar, palette pop-out, sidebar, shortcuts, boot
   ========================================================================== */
