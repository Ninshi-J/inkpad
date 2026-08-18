"use strict";
function resetDocState() {
  stopPlayback(); stopRecord();
  doc.strokes = []; doc.tapes = []; doc.texts = []; doc.images = []; doc.timers = []; doc.tables = [];
  audio.segments.forEach(s => URL.revokeObjectURL(s.url));
  audio.segments = []; audio.totalMs = 0; audio.posMs = 0;
  S.pages = 1;
  V.scroll = 0;
  undoStack = []; redoStack = [];
  clearSelection();
  mmCache.clear();
  dirty = false;
  resetCleanMarkers();
  needsDraw = true; syncUI(); syncStatus();
}
function deleteDocument() {
  resetDocState();
  scheduleAutosave(); // persist the now-empty state back into the active notebook
}

/* ---------------- PDF Engine Engine Loader ---------------- */
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    sc.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      res(window.pdfjsLib);
    };
    sc.onerror = () => {
      pdfjsReady = null;
      rej(new Error("Could not load the PDF engine."));
    };
    document.head.appendChild(sc);
  });
  return pdfjsReady;
}

let pdfLibReady = null;
function loadPdfLib() {
  if (pdfLibReady) return pdfLibReady;
  pdfLibReady = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
    sc.onload = () => res(window.PDFLib);
    sc.onerror = () => { pdfLibReady = null; rej(new Error("Could not load the PDF export engine.")); };
    document.head.appendChild(sc);
  });
  return pdfLibReady;
}

// Raw bytes of every PDF a user has imported, keyed by an id stamped onto each doc.images entry
// sourced from it — lets export re-embed the *original* page as vector content instead of the
// raster preview. serialize()/deserialize() persist these (see pdfSourceB64Cache below) so
// fidelity survives both autosave and explicit Save/Open round-trips.
let pdfSourceSeq = 0;
const pdfSources = new Map(); // id -> ArrayBuffer
const pdfSourceB64Cache = new Map(); // id -> base64 string, computed once per id and reused across every autosave

const PDF_MIN_PX_PER_UNIT = 2;
const PDF_MAX_PX_PER_UNIT = 5;   
const PDF_UPGRADE_HYSTERESIS = 1.15; 
const PDF_MAX_CANVAS_EDGE = 4096;    

function pdfRenderScaleFor(zoom, dpr) {
  const wanted = zoom * (dpr || 1);
  return Math.min(PDF_MAX_PX_PER_UNIT, Math.max(PDF_MIN_PX_PER_UNIT, wanted));
}
function shouldUpgradePdfImage(currentPxPerUnit, zoom, dpr) {
  return pdfRenderScaleFor(zoom, dpr) > currentPxPerUnit * PDF_UPGRADE_HYSTERESIS;
}

// Renders im.pdfPage at the given px-per-unit scale and swaps it in as im.img/im.data — shared
// by the zoom-triggered upgrade below and by the initial re-render of a reopened whole-page PDF
// image that was saved without its own raster (see restorePdfLiveLinks).
async function renderPdfImageAt(im, desired) {
  let scale = im.pdfFit * desired;
  let vp = im.pdfPage.getViewport({ scale });
  const longEdge = Math.max(vp.width, vp.height);
  if (longEdge > PDF_MAX_CANVAS_EDGE) {
    scale *= PDF_MAX_CANVAS_EDGE / longEdge;
    vp = im.pdfPage.getViewport({ scale });
  }
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
  await im.pdfPage.render({ canvasContext: cx, viewport: vp }).promise;
  const dataURL = c.toDataURL("image/jpeg", 0.9);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = dataURL; });
  if (im.del) return;
  im.img = img;
  im.data = dataURL;
  im.renderPxPerUnit = scale / im.pdfFit;
  needsDraw = true;
}

async function upgradePdfImage(im) {
  if (!im.pdfPage || im._pdfBusy || im.del) return;
  const desired = pdfRenderScaleFor(V.zoom, DPR);
  if (!shouldUpgradePdfImage(im.renderPxPerUnit, V.zoom, DPR)) return;
  im._pdfBusy = true;
  try {
    await renderPdfImageAt(im, desired);
  } catch (_) {
  } finally {
    im._pdfBusy = false;
  }
}

function upgradeVisiblePdfImages() {
  const top = V.scroll, bot = V.scroll + CH / V.zoom;
  for (const im of doc.images) {
    if (im.del || !im.pdfPage || im.y > bot || im.y + im.h < top) continue;
    if (shouldUpgradePdfImage(im.renderPxPerUnit, V.zoom, DPR)) upgradePdfImage(im);
  }
}
let pdfUpgradeTimer = null;
function schedulePdfUpgrade() {
  clearTimeout(pdfUpgradeTimer);
  pdfUpgradeTimer = setTimeout(upgradeVisiblePdfImages, 220);
}

// Same "does this page have anything on it" check clearCurrentPage (js/sidebar.js) does inline —
// factored out here since importPdfFiles below is a second, genuinely reusable caller.
function isPageBlank(p) {
  const top = p * stride(), bot = top + pageDims(p).h;
  const inPage = y => y >= top && y < bot;
  return !doc.strokes.some(s => !s.del && inPage(s.pts[0].y))
    && !doc.tapes.some(t => !t.del && inPage(t.y))
    && !doc.texts.some(t => !t.del && inPage(t.y))
    && !doc.images.some(i => !i.del && inPage(i.y))
    && !doc.timers.some(t => !t.del && inPage(t.y));
}

async function importPdfFiles(files) {
  let lib;
  try { lib = await loadPdfJs(); } catch (err) { notifyDialog("PDF import unavailable", err.message); return; }

  const candidates = [];
  for (const f of files) {
    try {
      const data = await f.arrayBuffer();
      // pdf.js may transfer (detach) the buffer it's handed to its worker, so stash an
      // untouched copy for export before data is passed along.
      const srcId = ++pdfSourceSeq;
      pdfSources.set(srcId, data.slice(0));
      const pdf = await lib.getDocument({ data }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        let vp = page.getViewport({ scale: 1 });
        // Full page size in PDF points (scale-1 viewport) — the reference box a vector crop's
        // sub-rectangle is measured against, kept even after later crops shrink pdfBox further.
        const pageBox = { left: 0, bottom: 0, right: vp.width, top: vp.height };
        const fit = Math.min(pageW() / vp.width, pageH() / vp.height);
        vp = page.getViewport({ scale: fit * 2 });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const c2 = c.getContext("2d");
        c2.fillStyle = "#fff"; c2.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: c2, viewport: vp }).promise;
        candidates.push({
          label: files.length > 1 ? `${f.name} — p.${n}` : `Page ${n}`,
          dataURL: c.toDataURL("image/jpeg", 0.85),
          w: vp.width / 2, h: vp.height / 2,
          page, fit, pdfSrcId: srcId, pdfPageIndex: n - 1, pdfBox: pageBox,
        });
      }
    } catch (err) { notifyDialog("Could not read that PDF", `${f.name}

${err.message}`); }
  }
  if (!candidates.length) return;

  const chosen = await showPagePicker({
    title: `Import from PDF — ${candidates.length} page${candidates.length > 1 ? "s" : ""} found`,
    items: candidates.map(c => ({ label: c.label, thumbURL: c.dataURL })),
    okLabel: "Import selected",
  });
  if (!chosen) return;

  // If the page you're currently viewing is empty, the import fills THAT page directly instead
  // of leaving it blank and inserting the PDF after it — only pages beyond the first get newly
  // inserted (right after it, same as the non-blank case below). Otherwise, insert right after
  // whichever page is currently in view — if that's also the last page (the common case), this
  // simply appends, same as before; if you've navigated to a page in the middle of the document
  // first, the PDF lands there instead, pushing later pages down.
  const activePage = curPage();
  const reuseBlankPage = isPageBlank(activePage);
  let atPage = reuseBlankPage ? activePage : activePage + 1;
  const firstNewPage = atPage;
  const newPagesNeeded = reuseBlankPage ? chosen.length - 1 : chosen.length;
  if (newPagesNeeded > 0) insertPageAt(activePage + 1, newPagesNeeded);

  const added = [];
  const newImages = [];
  for (const idx of chosen) {
    const c = candidates[idx];
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = c.dataURL; });
    const dims = pageDims(atPage);
    const im = {
      img, data: c.dataURL, pdf: true,
      x: (dims.w - c.w) / 2, y: atPage * stride() + (dims.h - c.h) / 2,
      w: c.w, h: c.h, del: false,
      pdfPage: c.page, pdfFit: c.fit, renderPxPerUnit: 2,
      pdfSrcId: c.pdfSrcId, pdfPageIndex: c.pdfPageIndex, pdfBox: c.pdfBox, pdfWholePage: true,
      layer: currentLayerId(),
    };
    newImages.push(im);
    added.push({ kind: "image", ref: im });
    atPage++;
  }
  // Send imported PDF pages to the back of the image stack so any picture/shape added
  // later on the same page layers on top of them, instead of potentially covering them.
  doc.images.unshift(...newImages);
  pushUndo({ op: "add", items: added });
  V.scroll = Math.max(0, firstNewPage * stride() - 40);
  clampScroll(); markDirty(); syncUI();
  schedulePdfUpgrade();
}
$("filePdf").addEventListener("change", e => { importPdfFiles([...e.target.files]); e.target.value = ""; });

// Renumbers per-page template overrides after a page is inserted/removed at `atIndex`.
// dropAt=true (delete) discards whatever override sat on the removed page itself.
function remapPageStyles(atIndex, delta, dropAt) {
  const src = S.pageStyles || {};
  if (!Object.keys(src).length) return {};
  const out = {};
  for (const key of Object.keys(src)) {
    const idx = parseInt(key, 10);
    if (dropAt && idx === atIndex) continue;
    const newIdx = idx >= atIndex ? idx + delta : idx;
    if (newIdx >= 0) out[newIdx] = src[key];
  }
  return out;
}

function deleteCurrentPage() {
  if (S.pages <= 1) { clearCurrentPage(); return; }
  const p = curPage(), st = stride();
  const removed = [], shifted = [];
  // By which page each object is mostly ON, not by where its top edge falls — see objectSpan.
  // On the top-edge test, anything overhanging this page's top survived the delete and then sat
  // over the page that moved up into its place.
  const visit = (arr, kind) => arr.forEach(o => {
    if (o.del) return;
    const at = objectPageAtStride(o, kind, st);
    if (at === p) { o.del = true; removed.push({ kind, ref: o }); }
    else if (at > p) { shiftObject(o, kind, 0, -st); shifted.push({ kind, ref: o }); }
  });
  visit(doc.strokes, "stroke");
  visit(doc.tapes, "tape");
  visit(doc.texts, "text");
  visit(doc.images, "image");
  visit(doc.timers, "timer");
  visit(doc.tables, "table");
  S.pages--;
  const pageStylesBefore = S.pageStyles || {};
  const pageStylesAfter = remapPageStyles(p, -1, true);
  S.pageStyles = pageStylesAfter;
  pushUndo({ op: "pageDel", removed, shifted, d: stride(), pageStylesBefore, pageStylesAfter });
  clampScroll(); clearSelection(); markDirty(); syncUI();
}

// Inserts `count` blank page(s) at page index `atIndex`, shifting all content on that
// page and later down to make room — the inverse of deleteCurrentPage().
function insertPageAt(atIndex, count = 1) {
  count = Math.max(1, Math.min(count, MAX_PAGES - S.pages));
  if (count <= 0) return;
  const st = stride();
  const dy = st * count;
  const shifted = [];
  // Same rule as deleteCurrentPage: page membership by overlap, not by the top edge. An object
  // overhanging the boundary was left behind while its own page moved down without it.
  const visit = (arr, kind) => arr.forEach(o => {
    if (o.del) return;
    if (objectPageAtStride(o, kind, st) >= atIndex) { shiftObject(o, kind, 0, dy); shifted.push({ kind, ref: o }); }
  });
  visit(doc.strokes, "stroke");
  visit(doc.tapes, "tape");
  visit(doc.texts, "text");
  visit(doc.images, "image");
  visit(doc.timers, "timer");
  visit(doc.tables, "table");
  S.pages += count;
  const pageStylesBefore = S.pageStyles || {};
  const pageStylesAfter = remapPageStyles(atIndex, count, false);
  S.pageStyles = pageStylesAfter;
  pushUndo({ op: "pageIns", shifted, d: dy, count, pageStylesBefore, pageStylesAfter });
  clampScroll(); clearSelection(); markDirty(); syncUI();
}

/* ---------------- Page Content Verification ---------------- */
function pageHasContent(p) {
  const top = p * stride(), bot = top + stride();
  const inP = y => y >= top && y < bot;
  return doc.strokes.some(s => !s.del && inP(s.pts[0].y)) ||
    doc.tapes.some(t => !t.del && inP(t.y)) ||
    doc.texts.some(t => !t.del && inP(t.y)) ||
    doc.images.some(im => !im.del && inP(im.y)) ||
    doc.timers.some(t => !t.del && inP(t.y));
}

function renderPageThumbnail(p, thumbW, asCanvas) {
  const dims = pageDims(p);
  const scale = thumbW / dims.w;
  const thumbH = Math.round(dims.h * scale);
  const c = document.createElement("canvas");
  c.width = thumbW; c.height = thumbH;
  const thumbCtx = c.getContext("2d");
  thumbCtx.fillStyle = "#fff"; thumbCtx.fillRect(0, 0, thumbW, thumbH);
  const top = p * stride(), bot = top + stride();

  for (const im of doc.images) {
    if (im.del || im.y + im.h < top || im.y > bot || !isLayerVisible(im.layer)) continue;
    if (im.rot || im.flipX || im.flipY) {
      thumbCtx.save();
      thumbCtx.translate((im.x + im.w / 2) * scale, (im.y + im.h / 2 - top) * scale);
      if (im.rot) thumbCtx.rotate(im.rot);
      thumbCtx.scale(im.flipX ? -1 : 1, im.flipY ? -1 : 1);
      thumbCtx.drawImage(im.img, -im.w * scale / 2, -im.h * scale / 2, im.w * scale, im.h * scale);
      thumbCtx.restore();
    } else {
      thumbCtx.drawImage(im.img, im.x * scale, (im.y - top) * scale, im.w * scale, im.h * scale);
    }
  }
  for (const pass of ["hl", "pen"]) {
    for (const s of doc.strokes) {
      if (s.del || s.tool !== pass || !s.pts.length || !isLayerVisible(s.layer)) continue;
      if (s.pts[0].y < top || s.pts[0].y >= bot) continue;
      thumbCtx.save();
      thumbCtx.globalAlpha = pass === "hl" ? 0.4 : 1;
      thumbCtx.strokeStyle = s.color;
      thumbCtx.lineWidth = Math.max(0.6, s.w * scale * (pass === "hl" ? 2.4 : 1));
      thumbCtx.lineCap = "round"; thumbCtx.lineJoin = "round";
      thumbCtx.beginPath();
      s.pts.forEach((pt, i) => {
        const x = pt.x * scale, y = (pt.y - top) * scale;
        i ? thumbCtx.lineTo(x, y) : thumbCtx.moveTo(x, y);
      });
      thumbCtx.stroke();
      thumbCtx.restore();
    }
  }
  for (const t of doc.tapes) {
    if (t.del || t.revealed || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
    thumbCtx.fillStyle = t.color || "#FFD682";
    thumbCtx.fillRect(t.x * scale, (t.y - top) * scale, t.w * scale, t.h * scale);
  }
  for (const t of doc.timers) {
    if (t.del || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
    thumbCtx.fillStyle = "#D5E8E5"; thumbCtx.strokeStyle = "#0F766E"; thumbCtx.lineWidth = 1;
    thumbCtx.fillRect(t.x * scale, (t.y - top) * scale, t.w * scale, t.h * scale);
    thumbCtx.strokeRect(t.x * scale, (t.y - top) * scale, t.w * scale, t.h * scale);
  }
  thumbCtx.textBaseline = "top";
  for (const t of doc.texts) {
    if (t.del || t.y < top || t.y >= bot || !isLayerVisible(t.layer)) continue;
    if (t.bg) {
      const r = textBB(t);
      thumbCtx.fillStyle = t.bg;
      thumbCtx.fillRect(r.x0 * scale, (r.y0 - top) * scale, (r.x1 - r.x0) * scale, (r.y1 - r.y0) * scale);
    }
    thumbCtx.fillStyle = t.color;
    thumbCtx.font = `${Math.max(6, t.size * scale)}px ${fontCss(t)}`;
    wrappedLines(t).forEach((ln, i) => thumbCtx.fillText(ln, t.x * scale, (t.y - top + i * t.size * 1.3) * scale));
  }
  return asCanvas ? c : c.toDataURL("image/png");
}

async function openExportDialog() {
  const items = [];
  for (let p = 0; p < S.pages; p++) {
    items.push({ label: `Page ${p + 1}`, thumbURL: renderPageThumbnail(p, 160), empty: !pageHasContent(p) });
  }
  const typeWrap = document.createElement("div");
  typeWrap.style.cssText = "display:flex;gap:16px;align-items:center;flex-wrap:wrap";
  typeWrap.innerHTML = `
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
      <input type="radio" name="exportType" value="pdf" checked> Vector PDF (.pdf)</label>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
      <input type="radio" name="exportType" value="svg"> Vector SVG (.svg)</label>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
      <input type="radio" name="exportType" value="png"> PNG image (.png)</label>
    <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
      <input type="radio" name="exportType" value="inkpad"> Editable file (.inkpad)</label>
    <label id="exportPngScaleWrap" style="display:none;align-items:center;gap:5px">
      Resolution
      <select id="exportPngScale">
        <option value="1">1×</option>
        <option value="2" selected>2×</option>
        <option value="4">4×</option>
      </select></label>`;
  // Resolution only means anything for the raster format, so it only appears for it.
  const scaleWrap = typeWrap.querySelector("#exportPngScaleWrap");
  typeWrap.querySelectorAll('input[name=exportType]').forEach(r => {
    r.onchange = () => { scaleWrap.style.display = r.value === "png" && r.checked ? "flex" : "none"; };
  });
  const chosen = await showPagePicker({
    title: "Export document",
    items,
    okLabel: "Export",
    extraControls: typeWrap,
  });
  if (!chosen) return;
  const type = typeWrap.querySelector('input[name=exportType]:checked').value;
  const fullDoc = chosen.length === S.pages;
  const pages = fullDoc ? null : chosen;
  try {
    if (type === "pdf") await exportPdf(pages);
    else if (type === "svg") await exportSvg(pages);
    else if (type === "png") await exportPng(pages, +typeWrap.querySelector("#exportPngScale").value);
    else saveFile(pages);
  } catch (err) {
    notifyDialog("Export failed", String(err && err.message || err));
  }
}

function buildFilteredDoc(pages) {
  const st = stride();
  const out = { strokes: [], tapes: [], texts: [], images: [], timers: [], tables: [] };
  pages.forEach((srcP, i) => {
    const top = srcP * st, bot = top + st;
    const shift = i * st - top;
    const inP = y => y >= top && y < bot;
    doc.strokes.forEach(s => { if (!s.del && inP(s.pts[0].y)) out.strokes.push({ ...s, pts: s.pts.map(p => ({ ...p, y: p.y + shift })) }); });
    doc.tapes.forEach(t => { if (!t.del && inP(t.y)) out.tapes.push({ ...t, y: t.y + shift }); });
    doc.texts.forEach(t => { if (!t.del && inP(t.y)) out.texts.push({ ...t, y: t.y + shift }); });
    doc.images.forEach(im => { if (!im.del && inP(im.y)) out.images.push({ ...im, y: im.y + shift }); });
    doc.timers.forEach(t => { if (!t.del && inP(t.y)) out.timers.push({ ...t, y: t.y + shift }); });
    doc.tables.forEach(t => { if (!t.del && inP(t.y)) out.tables.push({ ...t, y: t.y + shift }); });
  });
  return { ...out, pageCount: pages.length };
}

function bytesToB64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}
function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Carries each imported PDF's raw bytes (plus which page/crop each image uses) along with the
// rest of the document, so vector export still works after a reload — both the autosave
// snapshot (now IndexedDB-backed, see scheduleAutosave) and explicit Save/Export-to-file include
// it. Each PDF's bytes are base64'd once and cached (pdfSourceB64Cache) rather than redone on
// every autosave, since that encoding is real CPU work for a multi-MB scanned PDF.
async function serialize(pages) {
  const filtered = pages ? buildFilteredDoc(pages) : null;
  const src = filtered || {
    strokes: doc.strokes.filter(s => !s.del),
    tapes: doc.tapes.filter(t => !t.del),
    texts: doc.texts.filter(t => !t.del),
    images: doc.images.filter(i => !i.del),
    timers: doc.timers.filter(t => !t.del),
    tables: doc.tables.filter(t => !t.del),
    pageCount: S.pages,
  };
  const segs = [];
  if (!filtered) {
    for (const s of audio.segments) segs.push({ startMs: s.startMs, durMs: s.durMs, type: s.blob.type, b64: await blobToB64(s.blob) });
  }
  const pdfSourcesOut = {};
  for (const im of src.images) {
    if (im.pdfSrcId == null || pdfSourcesOut[im.pdfSrcId] != null) continue;
    if (!pdfSourceB64Cache.has(im.pdfSrcId)) {
      const bytes = pdfSources.get(im.pdfSrcId);
      if (bytes) pdfSourceB64Cache.set(im.pdfSrcId, bytesToB64(new Uint8Array(bytes)));
    }
    if (pdfSourceB64Cache.has(im.pdfSrcId)) pdfSourcesOut[im.pdfSrcId] = pdfSourceB64Cache.get(im.pdfSrcId);
  }
  // The union of the KaTeX faces the maths-labelled shapes on the page ask for — two, typically,
  // and nothing at all for a notebook with no maths in a shape.
  const katexFaces = [];
  for (const im of src.images) katexFaces.push(...shapeDataFaceKeys(im.data));
  const katexCssOut = katexFaces.length ? katexCssBundleFor(katexFaces) : null;
  return JSON.stringify({
    v: 1, settings: { ...S, pages: src.pageCount },
    strokes: src.strokes.map(s => ({
      tool: s.tool, color: s.color, w: s.w, t: filtered ? null : s.t, layer: s.layer, ...(s.grp ? { grp: s.grp } : {}),
      pts: s.pts.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round((p.p ?? .5) * 100) / 100]),
    })),
    tapes: src.tapes.map(({ x, y, w, h, color, revealed, layer, grp }) => ({ x, y, w, h, color, revealed, layer, ...(grp ? { grp } : {}) })),
    texts: src.texts.map(({ x, y, color, size, font, w, bg, lines, layer, grp }) => ({ x, y, color, size, font, w, bg: bg ?? null, lines, layer, ...(grp ? { grp } : {}) })),
    images: src.images.map(({ data, x, y, w, h, rot, flipX, flipY, pdfSrcId, pdfPageIndex, pdfBox, pdfWholePage, shapeGen, layer, grp }) => {
      const hasVectorSrc = pdfSrcId != null && pdfSourcesOut[pdfSrcId] != null;
      // A whole-page PDF import doesn't need its rendered raster preview saved too once the
      // original PDF bytes are being saved right alongside it — that preview gets regenerated
      // from those bytes as soon as the file's reopened (see restorePdfLiveLinks), so the file
      // isn't carrying the same page twice. Crops keep their raster: there's no source-bytes
      // path to regenerate just a cropped sub-region from yet.
      const skipRaster = hasVectorSrc && pdfWholePage;
      return {
        ...(skipRaster ? {} : { data }),
        x, y, w, h, rot: rot || 0, flipX: !!flipX, flipY: !!flipY,
        ...(hasVectorSrc ? { pdfSrcId, pdfPageIndex, pdfBox, pdfWholePage: !!pdfWholePage } : {}),
        ...(shapeGen ? { shapeGen } : {}),
        ...(grp ? { grp } : {}),
        layer,
      };
    }),
    // Never persisted as "running" — baseMs is frozen to whatever it's currently elapsed (even
    // mid-countdown) so a reopened notebook shows the same time it was left at, but always paused;
    // startWall (a performance.now() anchor) is meaningless across a reload so it's dropped entirely.
    timers: src.timers.map(t => ({
      x: t.x, y: t.y, w: t.w, h: t.h, mode: t.mode, durationMs: t.durationMs,
      baseMs: t.running ? timerObjElapsedMs(t) : t.baseMs, layer: t.layer, ...(t.grp ? { grp: t.grp } : {}),
    })),
    tables: src.tables.map(tableToJson),
    // The page pitch these coordinates were laid out against. Recorded because it is not derivable
    // from the settings alone across versions: an all-landscape document used to reserve PORTRAIT
    // height per page, so a file written by that build puts page 2 onwards where this build no
    // longer looks. deserialize migrates when they disagree.
    pageStride: stride(),
    audio: segs,
    ...(Object.keys(pdfSourcesOut).length ? { pdfSources: pdfSourcesOut } : {}),
    // One shared copy of the KaTeX faces this notebook's shapes need, rather than ~82KB inside
    // each of them (see stampShapeMathFaces). Saved rather than refetched because KaTeX comes off
    // a CDN that sw.js never caches, so without this a graph would need the network to draw.
    ...(katexCssOut ? { katexCss: katexCssOut } : {}),
  });
}
function blobToB64(blob) {
  return new Promise(res => {
    const rd = new FileReader();
    rd.onload = () => res(rd.result.split(",")[1]);
    rd.readAsDataURL(blob);
  });
}
function deserialize(json) {
  stopPlayback(); stopRecord();
  const d = JSON.parse(json);
  S.pageStyles = {}; // reset before merge — older/other files may not carry this key at all
  S.shapePrefs = {}; // same — notebooks saved before this existed have no key for it at all
  S.layers = null; S.activeLayer = null; // same — otherwise a save with no layers key would inherit whatever notebook was open before this one, instead of falling back to defaultLayers() below
  Object.assign(S, d.settings || {});
  doc.strokes = (d.strokes || []).map(s => {
    const ns = { tool: s.tool, color: s.color, w: s.w, t: s.t ?? null, layer: s.layer, del: false, ...(s.grp ? { grp: s.grp } : {}), pts: s.pts.map(a => ({ x: a[0], y: a[1], p: a[2] ?? 0.5 })) };
    ns.bb = strokeBB(ns); return ns;
  });
  doc.tapes = (d.tapes || []).map(t => ({ ...t, del: false }));
  doc.texts = (d.texts || []).map(t => ({ ...t, del: false }));
  doc.timers = (d.timers || []).map(t => ({ ...t, running: false, startWall: null, del: false }));
  doc.tables = (d.tables || []).map(tableFromJson);

  // Persisted PDF source bytes (if this file was saved with them) get remapped onto fresh
  // in-memory ids — this session may already have allocated ids for PDFs imported before this
  // file was opened, so the saved ids can't just be reused as-is.
  const srcIdRemap = {};
  for (const [oldId, b64] of Object.entries(d.pdfSources || {})) {
    const newId = ++pdfSourceSeq;
    pdfSources.set(newId, b64ToBytes(b64).buffer);
    srcIdRemap[oldId] = newId;
  }

  // Before any image decodes: this notebook's own copy of the maths fonts, which is what a graph
  // gets spliced with in setShapeImgSrc below.
  registerSavedKatexCss(d.katexCss || null);

  doc.images = [];
  for (const i of (d.images || [])) {
    const img = new Image();
    // Saved before the fonts were hoisted out of each shape? Lift them into the shared copy now,
    // so this notebook shrinks the next time it's saved (see demoteShapeDataUrl).
    const data = i.data ? demoteShapeDataUrl(i.data) : i.data;
    // A whole-page PDF image saved without its raster (see serialize()) has no i.data yet —
    // left blank here, it draws as nothing until restorePdfLiveLinks() re-renders it below.
    if (data) {
      img.onload = () => { needsDraw = true; mmCache.clear(); };
      setShapeImgSrc(img, data);
    }
    const im = { img, data: data || null, x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot || 0, flipX: !!i.flipX, flipY: !!i.flipY, layer: i.layer, del: false };
    if (i.shapeGen) im.shapeGen = i.shapeGen;
    if (i.grp) im.grp = i.grp;
    if (i.pdfSrcId != null && srcIdRemap[i.pdfSrcId] != null) {
      im.pdfSrcId = srcIdRemap[i.pdfSrcId];
      im.pdfPageIndex = i.pdfPageIndex;
      im.pdfBox = i.pdfBox;
      im.pdfWholePage = !!i.pdfWholePage;
    }
    doc.images.push(im);
  }

  // Migration: a notebook saved before layers existed (no S.layers at all, since Object.assign
  // above only overwrites keys the save actually has), or one whose active/object layer id no
  // longer exists (a deleted layer, or a foreign id from a stamp/paste sourced from a different
  // notebook), gets normalized onto a real layer here rather than silently going invisible.
  if (!Array.isArray(S.layers) || !S.layers.length) S.layers = defaultLayers();
  if (!S.activeLayer || !S.layers.some(l => l.id === S.activeLayer)) S.activeLayer = S.layers[0].id;
  const fallbackLayerId = S.layers[0].id;
  const validLayerIds = new Set(S.layers.map(l => l.id));
  for (const arr of [doc.strokes, doc.tapes, doc.texts, doc.images, doc.timers]) {
    for (const o of arr) if (!validLayerIds.has(o.layer)) o.layer = fallbackLayerId;
  }

  audio.segments.forEach(s => URL.revokeObjectURL(s.url));
  audio.segments = []; audio.totalMs = 0; audio.posMs = 0;
  for (const a of (d.audio || [])) {
    const bin = atob(a.b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: a.type });
    audio.segments.push({ blob, url: URL.createObjectURL(blob), startMs: a.startMs, durMs: a.durMs });
    audio.totalMs = Math.max(audio.totalMs, a.startMs + a.durMs);
  }
  /* Files written before pageStride existed carry no pitch. Only an all-landscape document can be
     wrong — portrait's pitch never changed — so that is the only case where a missing marker is
     read as "the old value"; anything else is left exactly where it is rather than guessed at. */
  const savedStride = d.pageStride != null ? d.pageStride
    : (documentIsAllLandscape() ? PAPERS[S.paper][1] + PAGE_GAP : stride());
  if (reflowPagesForStride(savedStride, stride())) bumpPages(contentBottom());

  undoStack = []; redoStack = []; clearSelection();
  V.scroll = 0; dirty = false;
  resetCleanMarkers();
  mmCache.clear();
  needsDraw = true; syncUI(); syncStatus(); rebuildSidebar(); renderLayersPanel();
  restorePdfLiveLinks();
}
// Re-links whole-page PDF images to a live pdf.js page (same as right after import), using the
// source bytes just restored from the file — without this, a reopened PDF import can never
// re-render sharper on zoom, since that only happens through a live page reference. Cropped
// images are left alone: they never had this "sharpen on zoom" capability even freshly imported.
//
// Also regenerates the raster for any image serialize() saved *without* one (whole-page images
// with their source bytes included skip storing a redundant preview — see serialize()) — those
// briefly draw as nothing until this render lands.
async function restorePdfLiveLinks() {
  const bySrc = new Map(); // srcId -> Promise<pdfjsDoc|null>
  for (const im of doc.images) {
    if (im.del || !im.pdfWholePage || im.pdfSrcId == null || im.pdfPage || bySrc.has(im.pdfSrcId)) continue;
    const bytes = pdfSources.get(im.pdfSrcId);
    bySrc.set(im.pdfSrcId, bytes
      ? loadPdfJs().then(lib => lib.getDocument({ data: bytes.slice(0) }).promise).catch(() => null)
      : Promise.resolve(null));
  }
  for (const im of doc.images) {
    if (im.del || !im.pdfWholePage || im.pdfSrcId == null || im.pdfPage) continue;
    const pdfPromise = bySrc.get(im.pdfSrcId);
    if (!pdfPromise) continue;
    try {
      const pdf = await pdfPromise;
      if (!pdf || im.del) continue;
      const page = await pdf.getPage(im.pdfPageIndex + 1);
      if (im.del) continue;
      const vp = page.getViewport({ scale: 1 });
      im.pdfPage = page;
      im.pdfFit = Math.min(pageW() / vp.width, pageH() / vp.height);
      im.renderPxPerUnit = 2;
      if (!im.data) {
        im._pdfBusy = true;
        try { await renderPdfImageAt(im, pdfRenderScaleFor(V.zoom, DPR)); }
        finally { im._pdfBusy = false; }
      }
    } catch (_) {}
  }
  schedulePdfUpgrade();
}
async function saveFile(pages) {
  const blob = new Blob([await serialize(pages)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = notebookFileStem() + ".inkpad";
  a.click();
  URL.revokeObjectURL(a.href);
  if (!pages) { dirty = false; syncStatus(); } 
}
$("fileOpen").addEventListener("change", e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { deserialize(rd.result); } catch (err) { notifyDialog("Could not open that file", err.message); } };
  rd.readAsText(f);
});

// Document storage lives in IndexedDB rather than localStorage — its quota is typically hundreds
// of MB to GB (vs. localStorage's shared ~5-10MB), which is what makes it safe to carry full PDF
// source bytes too (see serialize()), not just a lightweight snapshot. Three stores: "folders" and
// "notebooks" hold small metadata only (cheap to getAll() for rendering the sidebar tree), while
// each notebook's actual document JSON lives keyed-by-id in "docdata" so listing the library never
// has to load every notebook's (potentially multi-MB) content into memory. "autosave" is the
// original v1 single-document store, kept around only so initLibrary() can migrate it once.
